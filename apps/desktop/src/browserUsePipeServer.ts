// FILE: browserUsePipeServer.ts
// Purpose: Exposes the in-app browser over a Codex-compatible browser-use native pipe.
// Layer: Desktop browser automation bridge
// Depends on: DesktopBrowserManager and Node net server primitives

import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  BrowserCaptureScreenshotResult,
  BrowserExecuteCdpInput,
  ThreadBrowserState,
  ThreadId,
} from "@t3tools/contracts";
import {
  DPCODE_BROWSER_USE_IAB_PIPE_PATH,
  DPCODE_BROWSER_USE_IAB_PIPE_PATHS,
} from "@t3tools/shared/browserUse";

import type { DesktopBrowserManager } from "./browserManager";
import { BrowserUsePolicy } from "./browserUsePolicy";

const BROWSER_USE_HEADER_BYTES = 4;
const BROWSER_USE_MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const BROWSER_USE_INITIAL_URL = "about:blank";
const BROWSER_USE_BACKEND_NAME = "DP Code In-app Browser";
const BROWSER_USE_BACKEND_VERSION = "0.1.0";
const BROWSER_USE_PANEL_READY_TIMEOUT_MS = 3_000;
const BROWSER_USE_PANEL_READY_POLL_MS = 50;

type BrowserUseRpcId = string | number;

interface BrowserUseRpcRequest {
  id?: BrowserUseRpcId;
  method?: string;
  params?: unknown;
}

interface BrowserUseTrackedTab {
  id: number;
  threadId: ThreadId;
  tabId: string;
}

interface BrowserUseTabInfo {
  id: number;
  title: string;
  active: boolean;
  url: string;
}

interface BrowserUseUserTabInfo extends BrowserUseTabInfo {
  lastOpened?: string;
}

interface BrowserUseScreenshotResult {
  name: string;
  mimeType: "image/png";
  sizeBytes: number;
  data: string;
}

interface BrowserUsePipeServerOptions {
  readonly pipePaths?: string | readonly string[];
  readonly policy?: BrowserUsePolicy;
  readonly requestOpenPanel?: () => void | Promise<void>;
}

export const DPCODE_BROWSER_USE_PIPE_PATH = DPCODE_BROWSER_USE_IAB_PIPE_PATH;
export const DPCODE_BROWSER_USE_PIPE_PATHS = DPCODE_BROWSER_USE_IAB_PIPE_PATHS;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function asMouseButton(value: unknown): "left" | "middle" | "right" | null {
  return value === "left" || value === "middle" || value === "right" ? value : null;
}

function requireSessionId(params: unknown): string {
  const sessionId = asString(asObject(params)?.session_id);
  if (!sessionId) {
    throw new Error("Missing required browser session_id");
  }
  return sessionId;
}

function encodeBrowserUseFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(BROWSER_USE_HEADER_BYTES);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function decodeBrowserUseFrames(buffer: Buffer): { messages: string[]; remaining: Buffer } | null {
  let offset = 0;
  const messages: string[] = [];
  while (buffer.length - offset >= BROWSER_USE_HEADER_BYTES) {
    const messageLength =
      OS.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (messageLength > BROWSER_USE_MAX_MESSAGE_BYTES) {
      return null;
    }
    const frameLength = BROWSER_USE_HEADER_BYTES + messageLength;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      buffer.subarray(offset + BROWSER_USE_HEADER_BYTES, offset + frameLength).toString("utf8"),
    );
    offset += frameLength;
  }
  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

function ensurePipeParentDirectory(pipePath: string): void {
  if (process.platform === "win32") {
    return;
  }
  const parentDirectory = Path.dirname(pipePath);
  try {
    const stat = FS.statSync(parentDirectory);
    if (stat.isDirectory()) {
      return;
    }
    FS.unlinkSync(parentDirectory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
  FS.mkdirSync(parentDirectory, { recursive: true });
}

function cleanupPipePath(pipePath: string): void {
  if (process.platform === "win32" || !FS.existsSync(pipePath)) {
    return;
  }
  try {
    FS.unlinkSync(pipePath);
  } catch {
    // Ignore stale socket cleanup failures.
  }
}

export class BrowserUsePipeServer {
  private readonly sockets = new Set<Net.Socket>();
  private readonly pendingBySocket = new Map<Net.Socket, Buffer>();
  private readonly trackedTabByKey = new Map<string, BrowserUseTrackedTab>();
  private readonly trackedTabById = new Map<number, BrowserUseTrackedTab>();
  private readonly selectedTrackedTabIdBySessionId = new Map<string, number>();
  private readonly createdTrackedTabIdsBySessionId = new Map<string, Set<number>>();
  private readonly cdpListenerDisposeBySessionId = new Map<string, () => void>();
  private readonly servers = new Map<string, Net.Server>();
  private readonly pipePaths: readonly string[];
  private readonly policy: BrowserUsePolicy;
  private readonly requestOpenPanel?: () => void | Promise<void>;
  private nextTrackedTabId = 1;
  private started = false;

  constructor(
    private readonly browserManager: DesktopBrowserManager,
    options: BrowserUsePipeServerOptions | string | readonly string[] = {},
  ) {
    const pipePaths =
      typeof options === "string" || Array.isArray(options)
        ? options
        : options.pipePaths ?? DPCODE_BROWSER_USE_PIPE_PATHS;
    const normalizedPipePaths = (Array.isArray(pipePaths) ? pipePaths : [pipePaths]).filter(
      (pipePath) => pipePath.trim().length > 0,
    );
    this.pipePaths = [...new Set(normalizedPipePaths)];
    this.policy =
      typeof options === "object" && !Array.isArray(options)
        ? (options.policy ?? new BrowserUsePolicy())
        : new BrowserUsePolicy();
    this.requestOpenPanel =
      typeof options === "object" && !Array.isArray(options) ? options.requestOpenPanel : undefined;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const errors: Error[] = [];
    for (const pipePath of this.pipePaths) {
      try {
        await this.startPipe(pipePath);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.servers.size === 0) {
      throw errors[0] ?? new Error("No browser-use pipe paths were configured.");
    }
    this.started = true;
  }

  async dispose(): Promise<void> {
    for (const dispose of this.cdpListenerDisposeBySessionId.values()) {
      dispose();
    }
    this.cdpListenerDisposeBySessionId.clear();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.pendingBySocket.clear();
    if (this.started) {
      await Promise.all(
        [...this.servers.values()].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
      this.started = false;
    }
    for (const pipePath of this.servers.keys()) {
      cleanupPipePath(pipePath);
    }
    this.servers.clear();
    this.selectedTrackedTabIdBySessionId.clear();
    this.createdTrackedTabIdsBySessionId.clear();
    this.trackedTabByKey.clear();
    this.trackedTabById.clear();
  }

  // Opens one Codex-compatible JSON-RPC socket; exposing one route-scoped IAB
  // backend avoids Codex treating duplicate sockets as competing owners.
  private async startPipe(pipePath: string): Promise<void> {
    ensurePipeParentDirectory(pipePath);
    cleanupPipePath(pipePath);
    const server = Net.createServer((socket) => this.handleSocketConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pipePath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.servers.set(pipePath, server);
  }

  private handleSocketConnection(socket: Net.Socket): void {
    this.sockets.add(socket);
    this.pendingBySocket.set(socket, Buffer.alloc(0));
    socket.on("data", (chunk) => this.handleSocketData(socket, chunk));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
      this.pendingBySocket.delete(socket);
      socket.destroy();
    });
  }

  private handleSocketData(socket: Net.Socket, chunk: Buffer): void {
    const decoded = decodeBrowserUseFrames(
      Buffer.concat([this.pendingBySocket.get(socket) ?? Buffer.alloc(0), chunk]),
    );
    if (!decoded) {
      this.pendingBySocket.delete(socket);
      socket.destroy();
      return;
    }
    this.pendingBySocket.set(socket, decoded.remaining);
    for (const message of decoded.messages) {
      void this.handleIncomingMessage(socket, message);
    }
  }

  private async handleIncomingMessage(socket: Net.Socket, rawMessage: string): Promise<void> {
    let request: BrowserUseRpcRequest;
    try {
      request = JSON.parse(rawMessage) as BrowserUseRpcRequest;
    } catch {
      return;
    }

    if (request.id === undefined || typeof request.method !== "string") {
      return;
    }

    try {
      const result = await this.handleRequest(request.method, request.params);
      socket.write(encodeBrowserUseFrame({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      socket.write(
        encodeBrowserUseFrame({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: 1,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "ping":
        return "pong";
      case "getInfo":
        return this.getInfo(params);
      case "getTabs":
        return this.getTabsForSession(requireSessionId(params));
      case "getUserTabs":
        return this.getUserTabsForSession(requireSessionId(params));
      case "claimUserTab":
        return this.claimUserTabForSession(requireSessionId(params), params);
      case "createTab":
        return this.createTabForSession(requireSessionId(params));
      case "finalizeTabs":
        return this.finalizeTabsForSession(requireSessionId(params), params);
      case "nameSession":
        requireSessionId(params);
        if (!asString(asObject(params)?.name)) {
          throw new Error("nameSession requires a name");
        }
        return {};
      case "moveMouse":
        return this.moveMouseForSession(requireSessionId(params), params);
      case "click":
        return this.clickForSession(requireSessionId(params), params);
      case "tap":
        return this.clickForSession(requireSessionId(params), {
          ...(asObject(params) ?? {}),
          button: "left",
        });
      case "doubleClick":
        return this.clickForSession(requireSessionId(params), {
          ...(asObject(params) ?? {}),
          clickCount: 2,
        });
      case "scroll":
        return this.scrollForSession(requireSessionId(params), params);
      case "typeText":
        return this.typeTextForSession(requireSessionId(params), params);
      case "attach":
        return this.attachForSession(requireSessionId(params), params);
      case "detach":
        return this.detachForSession(requireSessionId(params));
      case "captureScreenshot":
        return this.captureScreenshotForSession(requireSessionId(params), params);
      case "executeCdp":
        return this.executeCdpForSession(requireSessionId(params), params);
      default:
        throw new Error(`No handler registered for method: ${method}`);
    }
  }

  private getInfo(params: unknown): {
    name: string;
    version: string;
    type: "iab";
    capabilities: { fileUploads: true };
    metadata?: { codexSessionId: string };
  } {
    const sessionId = asString(asObject(params)?.session_id);
    return {
      name: BROWSER_USE_BACKEND_NAME,
      version: BROWSER_USE_BACKEND_VERSION,
      type: "iab",
      capabilities: { fileUploads: true },
      ...(sessionId ? { metadata: { codexSessionId: sessionId } } : {}),
    };
  }

  private getActiveBrowserHostState(): {
    threadId: ThreadId;
    state: ThreadBrowserState;
  } | null {
    const snapshot = this.browserManager.getBrowserUseSnapshot();
    if (!snapshot || !snapshot.state.open) {
      return null;
    }
    return snapshot;
  }

  private async waitForActiveBrowserHostState(): Promise<{
    threadId: ThreadId;
    state: ThreadBrowserState;
  } | null> {
    const existing = this.getActiveBrowserHostState();
    if (existing) {
      return existing;
    }
    await this.requestOpenPanel?.();
    const deadline = Date.now() + BROWSER_USE_PANEL_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = this.getActiveBrowserHostState();
      if (snapshot) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, BROWSER_USE_PANEL_READY_POLL_MS));
    }
    return this.getActiveBrowserHostState();
  }

  private toBrowserUseTabInfo(
    sessionId: string,
    threadId: ThreadId,
    state: ThreadBrowserState,
    tab: ThreadBrowserState["tabs"][number],
  ): BrowserUseTabInfo {
    const tracked = this.trackTab(threadId, tab.id);
    const selectedTrackedTabId = this.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
    return {
      id: tracked.id,
      title: tab.title,
      active:
        selectedTrackedTabId === tracked.id ||
        (selectedTrackedTabId === null && state.activeTabId === tab.id),
      url: tab.lastCommittedUrl ?? tab.url,
    };
  }

  private trackTab(threadId: ThreadId, tabId: string): BrowserUseTrackedTab {
    const key = `${threadId}:${tabId}`;
    const existing = this.trackedTabByKey.get(key);
    if (existing) {
      return existing;
    }
    const tracked = {
      id: this.nextTrackedTabId,
      threadId,
      tabId,
    } satisfies BrowserUseTrackedTab;
    this.nextTrackedTabId += 1;
    this.trackedTabByKey.set(key, tracked);
    this.trackedTabById.set(tracked.id, tracked);
    return tracked;
  }

  private getTabsForSession(sessionId: string): BrowserUseTabInfo[] {
    const snapshot = this.getActiveBrowserHostState();
    if (!snapshot) {
      return [];
    }
    return snapshot.state.tabs.map((tab) =>
      this.toBrowserUseTabInfo(sessionId, snapshot.threadId, snapshot.state, tab),
    );
  }

  private getUserTabsForSession(sessionId: string): BrowserUseUserTabInfo[] {
    const now = new Date().toISOString();
    return this.getTabsForSession(sessionId).map((tab) => ({ ...tab, lastOpened: now }));
  }

  private claimUserTabForSession(sessionId: string, params: unknown): BrowserUseTabInfo {
    const trackedTabId = asPositiveInteger(asObject(params)?.tabId);
    if (trackedTabId === null) {
      throw new Error("claimUserTab requires a positive integer tabId");
    }
    const tracked = this.trackedTabById.get(trackedTabId);
    if (!tracked) {
      throw new Error(`Unknown user tab: ${trackedTabId}`);
    }
    const nextState = this.browserManager.selectTab({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
    });
    const tab = nextState.tabs.find((candidate) => candidate.id === tracked.tabId);
    if (!tab) {
      throw new Error(`Tab no longer exists: ${trackedTabId}`);
    }
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    return this.toBrowserUseTabInfo(sessionId, tracked.threadId, nextState, tab);
  }

  private async createTabForSession(sessionId: string): Promise<BrowserUseTabInfo> {
    const snapshot = await this.waitForActiveBrowserHostState();
    if (!snapshot) {
      throw new Error("No active DP Code browser pane available");
    }
    const nextState = this.browserManager.newTab({
      threadId: snapshot.threadId,
      url: BROWSER_USE_INITIAL_URL,
      activate: true,
    });
    const activeTab =
      nextState.tabs.find((tab) => tab.id === nextState.activeTabId) ?? nextState.tabs[0] ?? null;
    if (!activeTab) {
      throw new Error("Could not create a browser tab.");
    }
    const tracked = this.trackTab(snapshot.threadId, activeTab.id);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    this.rememberCreatedTab(sessionId, tracked.id);
    return {
      id: tracked.id,
      title: activeTab.title,
      active: true,
      url: activeTab.lastCommittedUrl ?? activeTab.url,
    };
  }

  private resolveTrackedTabForSession(sessionId: string, params: unknown): BrowserUseTrackedTab {
    const requestedTrackedTabId = asPositiveInteger(asObject(params)?.tabId);
    const trackedTabId =
      requestedTrackedTabId ?? this.selectedTrackedTabIdBySessionId.get(sessionId) ?? null;
    if (trackedTabId === null) {
      throw new Error("No browser tab selected for this session.");
    }
    const tracked = this.trackedTabById.get(trackedTabId);
    if (!tracked) {
      throw new Error(`Unknown tab: ${trackedTabId}`);
    }
    return tracked;
  }

  private async finalizeTabsForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const keepEntries = asObject(params)?.keep;
    const keepTrackedTabIds = new Set<number>();
    if (Array.isArray(keepEntries)) {
      for (const entry of keepEntries) {
        const tabId = asPositiveInteger(asObject(entry)?.tabId);
        if (tabId !== null) {
          keepTrackedTabIds.add(tabId);
        }
      }
    }

    const createdTrackedTabIds = this.createdTrackedTabIdsBySessionId.get(sessionId);
    if (!createdTrackedTabIds || createdTrackedTabIds.size === 0) {
      return {};
    }

    for (const trackedTabId of [...createdTrackedTabIds]) {
      if (keepTrackedTabIds.has(trackedTabId)) {
        continue;
      }
      const tracked = this.trackedTabById.get(trackedTabId);
      if (!tracked) {
        createdTrackedTabIds.delete(trackedTabId);
        continue;
      }
      try {
        this.browserManager.closeTab({ threadId: tracked.threadId, tabId: tracked.tabId });
        this.forgetTrackedTab(tracked);
      } catch {
        // Finalization is best-effort; stale tabs are cleaned from the local mapping.
        this.forgetTrackedTab(tracked);
      }
    }

    if (createdTrackedTabIds.size === 0) {
      this.createdTrackedTabIdsBySessionId.delete(sessionId);
    }
    const selectedTrackedTabId = this.selectedTrackedTabIdBySessionId.get(sessionId);
    if (selectedTrackedTabId !== undefined && !keepTrackedTabIds.has(selectedTrackedTabId)) {
      this.selectedTrackedTabIdBySessionId.delete(sessionId);
    }
    return {};
  }

  private rememberCreatedTab(sessionId: string, trackedTabId: number): void {
    const createdTrackedTabIds =
      this.createdTrackedTabIdsBySessionId.get(sessionId) ?? new Set<number>();
    createdTrackedTabIds.add(trackedTabId);
    this.createdTrackedTabIdsBySessionId.set(sessionId, createdTrackedTabIds);
  }

  private forgetTrackedTab(tracked: BrowserUseTrackedTab): void {
    this.trackedTabById.delete(tracked.id);
    this.trackedTabByKey.delete(`${tracked.threadId}:${tracked.tabId}`);
    for (const [sessionId, createdTrackedTabIds] of this.createdTrackedTabIdsBySessionId) {
      createdTrackedTabIds.delete(tracked.id);
      if (createdTrackedTabIds.size === 0) {
        this.createdTrackedTabIdsBySessionId.delete(sessionId);
      }
    }
    for (const [sessionId, selectedTrackedTabId] of this.selectedTrackedTabIdBySessionId) {
      if (selectedTrackedTabId === tracked.id) {
        this.selectedTrackedTabIdBySessionId.delete(sessionId);
      }
    }
  }

  private async attachForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    this.cdpListenerDisposeBySessionId.get(sessionId)?.();
    await this.browserManager.attachBrowserUseTab({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
    });
    const dispose = this.browserManager.subscribeToCdpEvents(
      {
        threadId: tracked.threadId,
        tabId: tracked.tabId,
      },
      (event) => {
        this.broadcastNotification("onCDPEvent", {
          source: {
            tabId: tracked.id,
          },
          method: event.method,
          ...(event.params !== undefined ? { params: event.params } : {}),
        });
      },
    );
    this.cdpListenerDisposeBySessionId.set(sessionId, dispose);
    return {};
  }

  private async detachForSession(sessionId: string): Promise<Record<string, never>> {
    this.cdpListenerDisposeBySessionId.get(sessionId)?.();
    this.cdpListenerDisposeBySessionId.delete(sessionId);
    return {};
  }

  private async captureScreenshotForSession(
    sessionId: string,
    params: unknown,
  ): Promise<BrowserUseScreenshotResult> {
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    const screenshot = (await this.browserManager.captureScreenshot({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
    })) as BrowserCaptureScreenshotResult;

    return {
      name: screenshot.name,
      mimeType: screenshot.mimeType,
      sizeBytes: screenshot.sizeBytes,
      data: Buffer.from(screenshot.bytes).toString("base64"),
    };
  }

  private async moveMouseForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const request = asObject(params);
    const x = asFiniteNumber(request?.x);
    const y = asFiniteNumber(request?.y);
    if (x === null || y === null) {
      throw new Error("moveMouse requires finite x and y coordinates");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    await this.browserManager.moveBrowserUseMouse({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      x,
      y,
    });
    return {};
  }

  private async clickForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const request = asObject(params);
    const x = asFiniteNumber(request?.x);
    const y = asFiniteNumber(request?.y);
    if (x === null || y === null) {
      throw new Error("click requires finite x and y coordinates");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    const button = asMouseButton(request?.button);
    const clickCount = asPositiveInteger(request?.clickCount);
    await this.browserManager.clickBrowserUseMouse({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      x,
      y,
      ...(button ? { button } : {}),
      ...(clickCount ? { clickCount } : {}),
    });
    return {};
  }

  private async scrollForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const request = asObject(params);
    const x = asFiniteNumber(request?.x);
    const y = asFiniteNumber(request?.y);
    const deltaX = asFiniteNumber(request?.deltaX);
    const deltaY = asFiniteNumber(request?.deltaY);
    if (x === null || y === null || deltaX === null || deltaY === null) {
      throw new Error("scroll requires finite x, y, deltaX, and deltaY coordinates");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    await this.browserManager.scrollBrowserUseMouse({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      x,
      y,
      deltaX,
      deltaY,
    });
    return {};
  }

  private async typeTextForSession(
    sessionId: string,
    params: unknown,
  ): Promise<Record<string, never>> {
    const request = asObject(params);
    const text = asString(request?.text);
    if (text === null) {
      throw new Error("typeText requires text");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, params);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    await this.browserManager.typeBrowserUseText({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      text,
    });
    return {};
  }

  private async executeCdpForSession(sessionId: string, params: unknown): Promise<unknown> {
    const request = asObject(params);
    const method = asString(request?.method);
    if (!method) {
      throw new Error("executeCdp requires a method");
    }
    const tracked = this.resolveTrackedTabForSession(sessionId, asObject(request?.target) ?? null);
    this.selectedTrackedTabIdBySessionId.set(sessionId, tracked.id);
    if (method === "Page.close") {
      this.browserManager.closeTab({ threadId: tracked.threadId, tabId: tracked.tabId });
      this.forgetTrackedTab(tracked);
      return {};
    }
    const commandParams = asObject(request?.commandParams);
    this.assertCdpCommandAllowed(method, commandParams);
    return this.browserManager.executeCdp({
      threadId: tracked.threadId,
      tabId: tracked.tabId,
      method,
      ...(commandParams ? { params: commandParams } : {}),
    } satisfies BrowserExecuteCdpInput);
  }

  private assertCdpCommandAllowed(
    method: string,
    commandParams: Record<string, unknown> | null,
  ): void {
    if (method !== "Page.navigate") {
      return;
    }
    const url = asString(commandParams?.url);
    if (!url) {
      throw new Error("Page.navigate requires a URL.");
    }
    this.policy.assertUrlAllowed(url);
  }

  private broadcastNotification(method: string, params: unknown): void {
    const payload = encodeBrowserUseFrame({
      jsonrpc: "2.0",
      method,
      params,
    });
    for (const socket of this.sockets) {
      if (!socket.destroyed) {
        socket.write(payload);
      }
    }
  }
}
