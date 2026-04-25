import { randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import { ThreadId, type BrowserTabInput, type ThreadBrowserState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserUsePipeServer } from "./browserUsePipeServer";
import type { DesktopBrowserManager } from "./browserManager";
import { BrowserUsePolicy } from "./browserUsePolicy";

interface BrowserUseMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface FakeBrowserManager {
  state: ThreadBrowserState;
  listeners: Array<(event: { method: string; params?: unknown }) => void>;
  closeTab: ReturnType<typeof vi.fn>;
  captureScreenshot: ReturnType<typeof vi.fn>;
  executeCdp: ReturnType<typeof vi.fn>;
  moveBrowserUseMouse: ReturnType<typeof vi.fn>;
  clickBrowserUseMouse: ReturnType<typeof vi.fn>;
  scrollBrowserUseMouse: ReturnType<typeof vi.fn>;
  typeBrowserUseText: ReturnType<typeof vi.fn>;
  getBrowserUseSnapshot: () => { threadId: ThreadId; state: ThreadBrowserState } | null;
  newTab: (input: { threadId: ThreadId; url?: string; activate?: boolean }) => ThreadBrowserState;
  selectTab: (input: BrowserTabInput) => ThreadBrowserState;
  attachBrowserUseTab: ReturnType<typeof vi.fn>;
  subscribeToCdpEvents: (
    input: BrowserTabInput,
    listener: (event: { method: string; params?: unknown }) => void,
  ) => () => void;
  emitCdp: (event: { method: string; params?: unknown }) => void;
}

const HEADER_BYTES = 4;

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer: Buffer): { messages: BrowserUseMessage[]; remaining: Buffer } {
  let offset = 0;
  const messages: BrowserUseMessage[] = [];
  while (buffer.length - offset >= HEADER_BYTES) {
    const messageLength =
      OS.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const frameLength = HEADER_BYTES + messageLength;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      JSON.parse(
        buffer.subarray(offset + HEADER_BYTES, offset + frameLength).toString("utf8"),
      ) as BrowserUseMessage,
    );
    offset += frameLength;
  }
  return { messages, remaining: buffer.subarray(offset) };
}

class BrowserUseRpcTestClient {
  private nextId = 1;
  private pendingBuffer = Buffer.alloc(0);
  private readonly pendingResponses = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly pendingNotifications: BrowserUseMessage[] = [];
  private notificationResolver: ((message: BrowserUseMessage) => void) | null = null;

  private constructor(private readonly socket: Net.Socket) {
    socket.on("data", (chunk) => this.handleData(chunk));
  }

  static async connect(pipePath: string): Promise<BrowserUseRpcTestClient> {
    const socket = Net.createConnection(pipePath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new BrowserUseRpcTestClient(socket);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingResponses.set(id, { resolve, reject });
    });
    this.socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
    return responsePromise;
  }

  async readNotification(): Promise<BrowserUseMessage> {
    const notification = this.pendingNotifications.shift();
    if (notification) {
      return notification;
    }
    return new Promise<BrowserUseMessage>((resolve) => {
      this.notificationResolver = resolve;
    });
  }

  destroy(): void {
    this.socket.destroy();
    for (const pending of this.pendingResponses.values()) {
      pending.reject(new Error("socket destroyed"));
    }
    this.pendingResponses.clear();
  }

  private handleData(chunk: Buffer): void {
    const decoded = decodeFrames(Buffer.concat([this.pendingBuffer, chunk]));
    this.pendingBuffer = decoded.remaining;
    for (const message of decoded.messages) {
      if (message.id !== undefined) {
        const pending = this.pendingResponses.get(message.id);
        this.pendingResponses.delete(message.id);
        if (message.error) {
          pending?.reject(new Error(message.error.message ?? "browser-use RPC failed"));
        } else {
          pending?.resolve(message.result);
        }
        continue;
      }
      if (this.notificationResolver) {
        const resolve = this.notificationResolver;
        this.notificationResolver = null;
        resolve(message);
      } else {
        this.pendingNotifications.push(message);
      }
    }
  }
}

function makeTab(id: string, url: string, title: string): ThreadBrowserState["tabs"][number] {
  return {
    id,
    url,
    title,
    status: "live",
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    lastCommittedUrl: url,
    lastError: null,
  };
}

function makeFakeBrowserManager(): FakeBrowserManager {
  const threadId = ThreadId.makeUnsafe("thread-browser-use");
  const manager: FakeBrowserManager = {
    state: {
      threadId,
      version: 1,
      open: true,
      activeTabId: "tab-1",
      tabs: [
        makeTab("tab-1", "https://example.com/", "Example"),
        makeTab("tab-2", "https://openai.com/", "OpenAI"),
      ],
      lastError: null,
    },
    listeners: [],
    closeTab: vi.fn((input: BrowserTabInput) => {
      manager.state = {
        ...manager.state,
        version: manager.state.version + 1,
        activeTabId:
          manager.state.activeTabId === input.tabId
            ? (manager.state.tabs.find((tab) => tab.id !== input.tabId)?.id ?? null)
            : manager.state.activeTabId,
        tabs: manager.state.tabs.filter((tab) => tab.id !== input.tabId),
      };
      return manager.state;
    }),
    captureScreenshot: vi.fn(async () => ({
      name: "browser-example.png",
      mimeType: "image/png",
      sizeBytes: 4,
      bytes: Uint8Array.from([1, 2, 3, 4]),
    })),
    executeCdp: vi.fn(async (input: { method: string; params?: unknown }) => ({
      method: input.method,
      params: input.params,
    })),
    moveBrowserUseMouse: vi.fn(async () => {}),
    clickBrowserUseMouse: vi.fn(async () => {}),
    scrollBrowserUseMouse: vi.fn(async () => {}),
    typeBrowserUseText: vi.fn(async () => {}),
    getBrowserUseSnapshot: () => ({ threadId, state: manager.state }),
    newTab: (input) => {
      const tab = makeTab(`tab-${manager.state.tabs.length + 1}`, input.url ?? "about:blank", "");
      manager.state = {
        ...manager.state,
        version: manager.state.version + 1,
        activeTabId: input.activate === false ? manager.state.activeTabId : tab.id,
        tabs: [...manager.state.tabs, tab],
      };
      return manager.state;
    },
    selectTab: (input) => {
      manager.state = {
        ...manager.state,
        version: manager.state.version + 1,
        activeTabId: input.tabId,
      };
      return manager.state;
    },
    attachBrowserUseTab: vi.fn(async () => {}),
    subscribeToCdpEvents: (_input, listener) => {
      manager.listeners.push(listener);
      return () => {
        manager.listeners = manager.listeners.filter((candidate) => candidate !== listener);
      };
    },
    emitCdp: (event) => {
      for (const listener of manager.listeners) {
        listener(event);
      }
    },
  };
  return manager;
}

function makeTempPipePath(): string {
  return Path.join(OS.tmpdir(), `dp-iab-${process.pid}-${randomUUID().slice(0, 8)}.sock`);
}

describe("BrowserUsePipeServer", () => {
  const clients: BrowserUseRpcTestClient[] = [];
  const tempPipePaths: string[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.destroy();
    }
    for (const pipePath of tempPipePaths.splice(0)) {
      FS.rmSync(pipePath, { force: true });
    }
  });

  async function startHarness(options?: {
    policy?: BrowserUsePolicy;
    requestOpenPanel?: () => void | Promise<void>;
  }): Promise<{
    client: BrowserUseRpcTestClient;
    manager: FakeBrowserManager;
    server: BrowserUsePipeServer;
  }> {
    const pipePath = makeTempPipePath();
    tempPipePaths.push(pipePath);
    const manager = makeFakeBrowserManager();
    const server = new BrowserUsePipeServer(
      manager as unknown as DesktopBrowserManager,
      options?.policy || options?.requestOpenPanel
        ? { pipePaths: pipePath, policy: options.policy, requestOpenPanel: options.requestOpenPanel }
        : pipePath,
    );
    await server.start();
    const client = await BrowserUseRpcTestClient.connect(pipePath);
    clients.push(client);
    return { client, manager, server };
  }

  it("advertises a Codex IAB backend with session metadata", async () => {
    const { client, server } = await startHarness();
    try {
      await expect(client.request("getInfo", { session_id: "codex-session" })).resolves.toEqual({
        name: "DP Code In-app Browser",
        version: "0.1.0",
        type: "iab",
        capabilities: { fileUploads: true },
        metadata: { codexSessionId: "codex-session" },
      });
    } finally {
      await server.dispose();
    }
  });

  it("maps tabs, claims a tab, executes CDP, and closes tabs through Codex RPC", async () => {
    const { client, manager, server } = await startHarness();
    try {
      const tabs = await client.request("getTabs", { session_id: "codex-session" });
      expect(tabs).toEqual([
        { id: 1, title: "Example", active: true, url: "https://example.com/" },
        { id: 2, title: "OpenAI", active: false, url: "https://openai.com/" },
      ]);

      await expect(
        client.request("claimUserTab", { session_id: "codex-session", tabId: 2 }),
      ).resolves.toMatchObject({ id: 2, active: true, url: "https://openai.com/" });

      await expect(
        client.request("executeCdp", {
          session_id: "codex-session",
          target: { tabId: 2 },
          method: "Runtime.evaluate",
          commandParams: { expression: "document.title" },
        }),
      ).resolves.toEqual({
        method: "Runtime.evaluate",
        params: { expression: "document.title" },
      });
      expect(manager.executeCdp).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-2",
        method: "Runtime.evaluate",
        params: { expression: "document.title" },
      });

      await expect(
        client.request("executeCdp", {
          session_id: "codex-session",
          target: { tabId: 2 },
          method: "Page.close",
        }),
      ).resolves.toEqual({});
      expect(manager.closeTab).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-2",
      });
    } finally {
      await server.dispose();
    }
  });

  it("sends native browser input and finalizes only tabs created by the session", async () => {
    const { client, manager, server } = await startHarness();
    try {
      await client.request("getTabs", { session_id: "codex-session" });
      const created = await client.request("createTab", { session_id: "codex-session" });
      expect(created).toMatchObject({ id: 3, active: true, url: "about:blank" });

      await expect(
        client.request("moveMouse", {
          session_id: "codex-session",
          tabId: 3,
          x: 24.4,
          y: 48.6,
        }),
      ).resolves.toEqual({});
      expect(manager.moveBrowserUseMouse).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        x: 24.4,
        y: 48.6,
      });

      await expect(
        client.request("click", {
          session_id: "codex-session",
          tabId: 3,
          x: 40,
          y: 50,
          button: "right",
          clickCount: 1,
        }),
      ).resolves.toEqual({});
      expect(manager.clickBrowserUseMouse).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        x: 40,
        y: 50,
        button: "right",
        clickCount: 1,
      });

      await expect(
        client.request("tap", {
          session_id: "codex-session",
          tabId: 3,
          x: 44,
          y: 54,
        }),
      ).resolves.toEqual({});
      expect(manager.clickBrowserUseMouse).toHaveBeenLastCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        x: 44,
        y: 54,
        button: "left",
      });

      await expect(
        client.request("doubleClick", {
          session_id: "codex-session",
          tabId: 3,
          x: 45,
          y: 55,
        }),
      ).resolves.toEqual({});
      expect(manager.clickBrowserUseMouse).toHaveBeenLastCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        x: 45,
        y: 55,
        clickCount: 2,
      });

      await expect(
        client.request("scroll", {
          session_id: "codex-session",
          tabId: 3,
          x: 100,
          y: 200,
          deltaX: 0,
          deltaY: 480,
        }),
      ).resolves.toEqual({});
      expect(manager.scrollBrowserUseMouse).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 480,
      });

      await expect(
        client.request("typeText", {
          session_id: "codex-session",
          tabId: 3,
          text: "hello",
        }),
      ).resolves.toEqual({});
      expect(manager.typeBrowserUseText).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
        text: "hello",
      });

      await expect(
        client.request("finalizeTabs", {
          session_id: "codex-session",
          keep: [],
        }),
      ).resolves.toEqual({});
      expect(manager.closeTab).toHaveBeenCalledTimes(1);
      expect(manager.closeTab).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-3",
      });
      expect(manager.state.tabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-2"]);
    } finally {
      await server.dispose();
    }
  });

  it("captures selected tab screenshots as base64 PNG payloads", async () => {
    const { client, manager, server } = await startHarness();
    try {
      await client.request("getTabs", { session_id: "codex-session" });

      await expect(
        client.request("captureScreenshot", {
          session_id: "codex-session",
          tabId: 2,
        }),
      ).resolves.toEqual({
        name: "browser-example.png",
        mimeType: "image/png",
        sizeBytes: 4,
        data: "AQIDBA==",
      });
      expect(manager.captureScreenshot).toHaveBeenCalledWith({
        threadId: manager.state.threadId,
        tabId: "tab-2",
      });
    } finally {
      await server.dispose();
    }
  });

  it("requests the browser panel before creating a tab when no pane is active", async () => {
    const requestOpenPanel = vi.fn(async () => {});
    const { client, manager, server } = await startHarness({ requestOpenPanel });
    const originalSnapshot = manager.getBrowserUseSnapshot;
    let hidden = true;
    manager.getBrowserUseSnapshot = () => {
      if (hidden) {
        hidden = false;
        return null;
      }
      return originalSnapshot();
    };

    try {
      const created = await client.request("createTab", { session_id: "codex-session" });

      expect(requestOpenPanel).toHaveBeenCalledTimes(1);
      expect(created).toMatchObject({ id: 1, active: true, url: "about:blank" });
    } finally {
      await server.dispose();
    }
  });

  it("forwards attached CDP events with browser-use tab ids", async () => {
    const { client, manager, server } = await startHarness();
    try {
      await client.request("getTabs", { session_id: "codex-session" });
      await expect(
        client.request("attach", { session_id: "codex-session", tabId: 1 }),
      ).resolves.toEqual({});

      manager.emitCdp({
        method: "Page.loadEventFired",
        params: { timestamp: 12 },
      });

      await expect(client.readNotification()).resolves.toEqual({
        jsonrpc: "2.0",
        method: "onCDPEvent",
        params: {
          source: { tabId: 1 },
          method: "Page.loadEventFired",
          params: { timestamp: 12 },
        },
      });
    } finally {
      await server.dispose();
    }
  });

  it("blocks Page.navigate when the local Browser Use policy denies the domain", async () => {
    const policy = new BrowserUsePolicy({
      approvalMode: "always-ask",
      blockedDomains: ["example.com"],
      allowedDomains: [],
    });
    const { client, manager, server } = await startHarness({ policy });
    try {
      await client.request("getTabs", { session_id: "codex-session" });

      await expect(
        client.request("executeCdp", {
          session_id: "codex-session",
          target: { tabId: 1 },
          method: "Page.navigate",
          commandParams: { url: "https://example.com/private" },
        }),
      ).rejects.toThrow("Browser Use is not permitted on example.com.");
      expect(manager.executeCdp).not.toHaveBeenCalled();
    } finally {
      await server.dispose();
    }
  });
});
