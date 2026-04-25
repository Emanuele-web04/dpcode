// FILE: browserUseMcpServer.ts
// Purpose: Exposes DP Code's in-app browser-use pipe as a tiny stdio MCP server.
// Layer: Provider integration transport
// Exports: native browser tool definitions plus runBrowserUseMcpServer for provider CLIs.

import * as Net from "node:net";
import * as OS from "node:os";

import { DPCODE_BROWSER_USE_IAB_PIPE_PATH } from "@t3tools/shared/browserUse";

const HEADER_BYTES = 4;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MCP_SERVER_NAME = "dpcode-browser";
const MCP_SERVER_VERSION = "0.1.0";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

interface BrowserUseRpcMessage {
  readonly id?: string | number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

export interface BrowserUseScreenshotResult {
  readonly name: string;
  readonly mimeType: "image/png";
  readonly sizeBytes: number;
  readonly data: string;
}

export interface BrowserToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly call: (args: Record<string, unknown>) => Promise<unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asMouseButton(value: unknown): "left" | "middle" | "right" | undefined {
  return value === "left" || value === "middle" || value === "right" ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : NaN;
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}

function asTabId(value: unknown): number | undefined {
  return asPositiveInteger(value);
}

function defaultSessionId(): string {
  return process.env.DPCODE_BROWSER_USE_SESSION_ID || "provider:browser-use";
}

function sessionParams(args: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: asString(args.sessionId) ?? defaultSessionId(),
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Optional browser-use session id. Defaults to this provider thread.",
      },
      ...properties,
    },
    required,
    additionalProperties: false,
  };
}

function encodeBrowserUseFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  if (OS.endianness() === "LE") {
    header.writeUInt32LE(payload.length, 0);
  } else {
    header.writeUInt32BE(payload.length, 0);
  }
  return Buffer.concat([header, payload]);
}

function decodeBrowserUseFrames(buffer: Buffer): { messages: BrowserUseRpcMessage[]; rest: Buffer } {
  let offset = 0;
  const messages: BrowserUseRpcMessage[] = [];
  while (buffer.length - offset >= HEADER_BYTES) {
    const length =
      OS.endianness() === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    if (length > MAX_MESSAGE_BYTES) {
      throw new Error("browser-use response exceeded the maximum supported size.");
    }
    const frameLength = HEADER_BYTES + length;
    if (buffer.length - offset < frameLength) {
      break;
    }
    messages.push(
      JSON.parse(
        buffer.subarray(offset + HEADER_BYTES, offset + frameLength).toString("utf8"),
      ) as BrowserUseRpcMessage,
    );
    offset += frameLength;
  }
  return { messages, rest: buffer.subarray(offset) };
}

async function callBrowserUse(method: string, params: Record<string, unknown>): Promise<unknown> {
  const socket = Net.createConnection(DPCODE_BROWSER_USE_IAB_PIPE_PATH);
  let buffer = Buffer.alloc(0);
  const id = 1;

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const response = await new Promise<BrowserUseRpcMessage>((resolve, reject) => {
      socket.on("data", (chunk) => {
        try {
          const decoded = decodeBrowserUseFrames(Buffer.concat([buffer, chunk]));
          buffer = decoded.rest;
          const message = decoded.messages.find((candidate) => candidate.id === id);
          if (message) {
            resolve(message);
          }
        } catch (error) {
          reject(error);
        }
      });
      socket.once("error", reject);
      socket.write(encodeBrowserUseFrame({ jsonrpc: "2.0", id, method, params }));
    });

    if (response.error) {
      throw new Error(response.error.message ?? "browser-use RPC failed.");
    }
    return response.result;
  } finally {
    socket.destroy();
  }
}

function toMcpTextResult(value: unknown): Record<string, unknown> {
  if (isBrowserUseScreenshotResult(value)) {
    return {
      content: [
        {
          type: "text",
          text: `Captured ${value.name} (${value.sizeBytes} bytes).`,
        },
        {
          type: "image",
          data: value.data,
          mimeType: value.mimeType,
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2),
      },
    ],
  };
}

export function isBrowserUseScreenshotResult(value: unknown): value is BrowserUseScreenshotResult {
  const record = asRecord(value);
  return (
    typeof record.name === "string" &&
    record.mimeType === "image/png" &&
    typeof record.sizeBytes === "number" &&
    Number.isFinite(record.sizeBytes) &&
    typeof record.data === "string" &&
    record.data.length > 0
  );
}

export function browserUseScreenshotDataUrl(value: BrowserUseScreenshotResult): string {
  return `data:${value.mimeType};base64,${value.data}`;
}

export function getBrowserUseToolDefinitions(): BrowserToolDefinition[] {
  const tabIdProperty = {
    type: "integer",
    minimum: 1,
    description: "Browser-use tab id from browser_list_tabs or browser_create_tab.",
  };
  const viewportPointProperties = {
    tabId: tabIdProperty,
    x: { type: "number", description: "Viewport x coordinate in CSS pixels." },
    y: { type: "number", description: "Viewport y coordinate in CSS pixels." },
  };

  return [
    {
      name: "browser_get_info",
      description: "Return information about the DP Code in-app browser backend.",
      inputSchema: objectSchema({}),
      call: (args) => callBrowserUse("getInfo", sessionParams(args)),
    },
    {
      name: "browser_list_tabs",
      description: "List tabs currently visible to Browser Use.",
      inputSchema: objectSchema({}),
      call: (args) => callBrowserUse("getTabs", sessionParams(args)),
    },
    {
      name: "browser_list_user_tabs",
      description: "List existing user-opened in-app browser tabs that can be claimed.",
      inputSchema: objectSchema({}),
      call: (args) => callBrowserUse("getUserTabs", sessionParams(args)),
    },
    {
      name: "browser_claim_user_tab",
      description: "Select an existing user tab for this provider browser session.",
      inputSchema: objectSchema({ tabId: tabIdProperty }, ["tabId"]),
      call: (args) =>
        callBrowserUse("claimUserTab", {
          ...sessionParams(args),
          tabId: asTabId(args.tabId),
        }),
    },
    {
      name: "browser_create_tab",
      description: "Create and select a new in-app browser tab.",
      inputSchema: objectSchema({}),
      call: (args) => callBrowserUse("createTab", sessionParams(args)),
    },
    {
      name: "browser_finalize_tabs",
      description: "Close tabs created by this browser session unless their ids are kept.",
      inputSchema: objectSchema({
        keepTabIds: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          description: "Created tab ids to leave open.",
        },
      }),
      call: (args) =>
        callBrowserUse("finalizeTabs", {
          ...sessionParams(args),
          keep: Array.isArray(args.keepTabIds)
            ? args.keepTabIds.flatMap((tabId) => {
                const id = asTabId(tabId);
                return id ? [{ tabId: id }] : [];
              })
            : [],
        }),
    },
    {
      name: "browser_navigate",
      description: "Navigate the selected tab, or a specific tab, to an http/https/about URL.",
      inputSchema: objectSchema({ tabId: tabIdProperty, url: { type: "string" } }, ["url"]),
      call: (args) =>
        callBrowserUse("executeCdp", {
          ...sessionParams(args),
          target: asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {},
          method: "Page.navigate",
          commandParams: { url: asString(args.url) },
        }),
    },
    {
      name: "browser_close_tab",
      description: "Close the selected tab, or the specified tab, through Browser Use.",
      inputSchema: objectSchema({ tabId: tabIdProperty }),
      call: (args) =>
        callBrowserUse("executeCdp", {
          ...sessionParams(args),
          target: asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {},
          method: "Page.close",
        }),
    },
    {
      name: "browser_move_mouse",
      description: "Move the native mouse cursor inside a browser tab viewport.",
      inputSchema: objectSchema(
        {
          tabId: tabIdProperty,
          x: { type: "number" },
          y: { type: "number" },
        },
        ["x", "y"],
      ),
      call: (args) =>
        callBrowserUse("moveMouse", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          x: asNumber(args.x),
          y: asNumber(args.y),
        }),
    },
    {
      name: "browser_click",
      description:
        "Send a real native mouse click at viewport coordinates in the selected in-app browser tab. Use this instead of DOM element.click() when the user asks to click or tap.",
      inputSchema: objectSchema(
        {
          ...viewportPointProperties,
          button: {
            type: "string",
            enum: ["left", "middle", "right"],
            description: "Mouse button. Defaults to left.",
          },
          clickCount: {
            type: "integer",
            minimum: 1,
            description: "Number of clicks. Defaults to 1.",
          },
        },
        ["x", "y"],
      ),
      call: (args) => {
        const button = asMouseButton(args.button);
        const clickCount = asPositiveInteger(args.clickCount);
        return callBrowserUse("click", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          x: asNumber(args.x),
          y: asNumber(args.y),
          ...(button ? { button } : {}),
          ...(clickCount ? { clickCount } : {}),
        });
      },
    },
    {
      name: "browser_tap",
      description:
        "Alias for a real left-button viewport click. Use for tap-like browser interaction, not DOM activation.",
      inputSchema: objectSchema(viewportPointProperties, ["x", "y"]),
      call: (args) =>
        callBrowserUse("tap", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          x: asNumber(args.x),
          y: asNumber(args.y),
        }),
    },
    {
      name: "browser_double_click",
      description: "Send a real native double-click at viewport coordinates.",
      inputSchema: objectSchema(viewportPointProperties, ["x", "y"]),
      call: (args) =>
        callBrowserUse("doubleClick", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          x: asNumber(args.x),
          y: asNumber(args.y),
        }),
    },
    {
      name: "browser_scroll",
      description:
        "Send a real viewport wheel event from a coordinate. Positive deltaY scrolls down, negative deltaY scrolls up.",
      inputSchema: objectSchema(
        {
          ...viewportPointProperties,
          deltaX: { type: "number", description: "Horizontal wheel delta in CSS pixels." },
          deltaY: { type: "number", description: "Vertical wheel delta in CSS pixels." },
        },
        ["x", "y", "deltaX", "deltaY"],
      ),
      call: (args) =>
        callBrowserUse("scroll", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          x: asNumber(args.x),
          y: asNumber(args.y),
          deltaX: asNumber(args.deltaX),
          deltaY: asNumber(args.deltaY),
        }),
    },
    {
      name: "browser_type_text",
      description:
        "Insert text into the currently focused browser element. Focus the target first with browser_click.",
      inputSchema: objectSchema(
        {
          tabId: tabIdProperty,
          text: { type: "string" },
        },
        ["text"],
      ),
      call: (args) =>
        callBrowserUse("typeText", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
          text: asString(args.text),
        }),
    },
    {
      name: "browser_attach",
      description: "Attach Browser Use CDP event forwarding to a selected or specific tab.",
      inputSchema: objectSchema({ tabId: tabIdProperty }),
      call: (args) =>
        callBrowserUse("attach", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
        }),
    },
    {
      name: "browser_detach",
      description: "Detach Browser Use CDP event forwarding for this browser session.",
      inputSchema: objectSchema({}),
      call: (args) => callBrowserUse("detach", sessionParams(args)),
    },
    {
      name: "browser_capture_screenshot",
      description:
        "Capture the selected browser tab viewport as an image the model can visually inspect.",
      inputSchema: objectSchema({ tabId: tabIdProperty }),
      call: (args) =>
        callBrowserUse("captureScreenshot", {
          ...sessionParams(args),
          ...(asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {}),
        }),
    },
    {
      name: "browser_execute_cdp",
      description: "Execute a Chrome DevTools Protocol command against the selected browser tab.",
      inputSchema: objectSchema(
        {
          tabId: tabIdProperty,
          method: { type: "string", description: "CDP method, for example Runtime.evaluate." },
          params: {
            type: "object",
            description: "CDP command parameters.",
            additionalProperties: true,
          },
        },
        ["method"],
      ),
      call: (args) =>
        callBrowserUse("executeCdp", {
          ...sessionParams(args),
          target: asTabId(args.tabId) ? { tabId: asTabId(args.tabId) } : {},
          method: asString(args.method),
          commandParams: asRecord(args.params),
        }),
    },
  ];
}

export async function callBrowserUseTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = getBrowserUseToolDefinitions().find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown browser tool: ${name}`);
  }
  return tool.call(args);
}

function encodeMcpMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "utf8"),
    payload,
  ]);
}

function decodeMcpMessages(buffer: Buffer): { messages: JsonRpcRequest[]; rest: Buffer } {
  const messages: JsonRpcRequest[] = [];
  let offset = 0;

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset, "utf8");
    if (headerEnd < 0) {
      break;
    }
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      throw new Error("MCP message is missing Content-Length.");
    }
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      break;
    }
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonRpcRequest);
    offset = bodyEnd;
  }

  return { messages, rest: buffer.subarray(offset) };
}

function writeMcp(message: unknown): void {
  process.stdout.write(encodeMcpMessage(message));
}

async function handleMcpRequest(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined || !request.method) {
    return;
  }

  try {
    if (request.method === "initialize") {
      writeMcp({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
      return;
    }

    if (request.method === "tools/list") {
      writeMcp({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: getBrowserUseToolDefinitions().map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        },
      });
      return;
    }

    if (request.method === "tools/call") {
      const params = asRecord(request.params);
      const name = asString(params.name);
      const result = await callBrowserUseTool(name ?? "<missing>", asRecord(params.arguments));
      writeMcp({ jsonrpc: "2.0", id: request.id, result: toMcpTextResult(result) });
      return;
    }

    throw new Error(`Unsupported MCP method: ${request.method}`);
  } catch (error) {
    writeMcp({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

// Starts a minimal MCP stdio loop; provider CLIs own process lifetime.
export async function runBrowserUseMcpServer(): Promise<void> {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    try {
      const decoded = decodeMcpMessages(Buffer.concat([buffer, chunk]));
      buffer = decoded.rest;
      for (const message of decoded.messages) {
        void handleMcpRequest(message);
      }
    } catch (error) {
      writeMcp({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
}
