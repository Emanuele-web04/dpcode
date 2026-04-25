// FILE: browserUseMcpServer.test.ts
// Purpose: Verifies the provider-facing Browser Use MCP process handshake.
// Layer: Provider integration transport test
// Depends on: Vitest and the local `t3 browser-use-mcp` entrypoint.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { browserUseScreenshotDataUrl, isBrowserUseScreenshotResult } from "./browserUseMcpServer.ts";
import {
  DPCODE_BROWSER_USE_MCP_SERVER_NAME,
  promptLooksLikeBrowserUseTask,
  resolveBrowserUseMcpProcessConfig,
} from "./browserUseTooling.ts";

interface McpMessage {
  id?: string | number | null;
  result?: {
    serverInfo?: { name?: string };
    tools?: Array<{ name: string }>;
    content?: Array<Record<string, unknown>>;
  };
}

const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
});

function encodeMcp(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function decodeMcp(buffer: Buffer): { messages: McpMessage[]; rest: Buffer } {
  const messages: McpMessage[] = [];
  let offset = 0;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset, "utf8");
    if (headerEnd < 0) break;
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + Number(match[1]);
    if (buffer.length < bodyEnd) break;
    messages.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as McpMessage);
    offset = bodyEnd;
  }
  return { messages, rest: buffer.subarray(offset) };
}

function spawnMcpServer(): {
  child: ChildProcessWithoutNullStreams;
  request: (method: string, params?: unknown) => Promise<McpMessage>;
} {
  const child = spawn("bun", ["src/index.ts", "browser-use-mcp"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DPCODE_BROWSER_USE_SESSION_ID: "test:browser",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);

  let nextId = 1;
  let stdout = Buffer.alloc(0);
  const waiters = new Map<number, (message: McpMessage) => void>();
  child.stdout.on("data", (chunk) => {
    const decoded = decodeMcp(Buffer.concat([stdout, chunk]));
    stdout = decoded.rest;
    for (const message of decoded.messages) {
      if (typeof message.id === "number") {
        waiters.get(message.id)?.(message);
        waiters.delete(message.id);
      }
    }
  });

  return {
    child,
    request: (method, params) => {
      const id = nextId;
      nextId += 1;
      const response = new Promise<McpMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}`));
        }, 5_000);
        waiters.set(id, (message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
      child.stdin.write(encodeMcp({ jsonrpc: "2.0", id, method, params }));
      return response;
    },
  };
}

describe("Browser Use provider MCP server", () => {
  it("recognizes screenshot results and builds image data URLs", () => {
    const screenshot = {
      name: "browser.png",
      mimeType: "image/png",
      sizeBytes: 4,
      data: "AQIDBA==",
    };

    expect(isBrowserUseScreenshotResult(screenshot)).toBe(true);
    if (!isBrowserUseScreenshotResult(screenshot)) {
      throw new Error("Expected a valid screenshot result.");
    }
    expect(browserUseScreenshotDataUrl(screenshot)).toBe("data:image/png;base64,AQIDBA==");
  });

  it("builds a per-thread MCP command config", () => {
    const config = resolveBrowserUseMcpProcessConfig({
      provider: "claudeAgent",
      threadId: ThreadId.makeUnsafe("thread-1"),
    });

    expect(config.command).toBe(process.execPath);
    expect(config.args.at(-1)).toBe("browser-use-mcp");
    expect(config.env.DPCODE_BROWSER_USE_SESSION_ID).toBe("claudeAgent:thread-1");
  });

  it("treats @browser as an explicit Browser Use routing tag", () => {
    expect(promptLooksLikeBrowserUseTask("@browser open https://example.com")).toBe(true);
    expect(promptLooksLikeBrowserUseTask("please use @browser")).toBe(true);
    expect(promptLooksLikeBrowserUseTask("summarize this file")).toBe(false);
  });

  it("advertises Browser Use MCP tools over stdio", async () => {
    const { request } = spawnMcpServer();

    await expect(request("initialize")).resolves.toMatchObject({
      result: { serverInfo: { name: DPCODE_BROWSER_USE_MCP_SERVER_NAME } },
    });
    const tools = await request("tools/list");

    expect(tools.result?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "browser_list_tabs",
        "browser_create_tab",
        "browser_navigate",
        "browser_click",
        "browser_tap",
        "browser_scroll",
        "browser_type_text",
        "browser_capture_screenshot",
        "browser_execute_cdp",
      ]),
    );
  });
});
