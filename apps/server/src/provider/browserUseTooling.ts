// FILE: browserUseTooling.ts
// Purpose: Defines the provider-facing Browser Use MCP launch config and prompt hints.
// Layer: Provider integration utility
// Exports: MCP server naming/config helpers shared by Claude, Gemini, and OpenCode adapters.

import type { ThreadId } from "@t3tools/contracts";

import { getBrowserUseToolDefinitions } from "./browserUseMcpServer.ts";

export const DPCODE_BROWSER_USE_MCP_SERVER_NAME = "dpcode-browser";
export const DPCODE_BROWSER_USE_DYNAMIC_TOOL_NAMESPACE = "dpcode_browser";

export const DPCODE_BROWSER_USE_PROVIDER_PROMPT = [
  "DP Code exposes the in-app browser through the dpcode-browser MCP tools.",
  "Use these tools when the user asks you to inspect, navigate, test, screenshot, or interact with browser content.",
  "Prefer browser_navigate for opening pages, browser_list_tabs/browser_create_tab for tab control, and browser_execute_cdp only when a lower-level Chrome DevTools Protocol command is needed.",
  "For user-like interaction, locate the target's viewport bounds and use browser_click/browser_tap/browser_double_click/browser_scroll/browser_type_text. Do not use DOM element.click() as a substitute for clicking unless the user explicitly asks for DOM scripting.",
  "Use browser_capture_screenshot when the user asks what the page looks like or when pixel-level visual layout matters.",
].join("\n");

const CODEX_BROWSER_USE_ROUTING_PROMPT = [
  "This DP Code turn is an in-app browser task.",
  "Use DP Code's native in-app browser tools in the dpcode_browser namespace to create or claim a tab, navigate pages, inspect the live browser state, click, type, screenshot, or read page metadata as needed.",
  "When clicking or tapping, use the native coordinate tools such as dpcode_browser.browser_click or dpcode_browser.browser_tap after resolving the element's viewport bounds. Do not use DOM element.click() unless the user explicitly asks for DOM scripting.",
  "Do not use the bundled Browser Use skill, a Codex plugin, browser/SKILL.md, node_repl, mcp__node_repl__js, or direct browser-client.mjs imports for this app.",
  "Do not answer this task from web search results or generic source snippets. Report only what you verified through the in-app browser.",
].join("\n");

const BROWSER_SCOPE_PATTERNS = [
  "browser",
  "in-app browser",
  "internal browser",
  "browser panel",
  "active tab",
  "current tab",
  "pagina aperta",
  "tab attiva",
  "browser interno",
];

const BROWSER_ACTION_PATTERNS = [
  "open ",
  "navigate",
  "go to",
  "visit ",
  "load ",
  "inspect",
  "read",
  "look at",
  "what do you see",
  "page title",
  "title",
  "screenshot",
  "click",
  "type",
  "fill",
  "scroll",
  "test",
  "ispeziona",
  "guarda",
  "leggi",
  "apri",
  "naviga",
  "titolo",
];

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')]+/i;
const BROWSER_TAG_PATTERN = /(?:^|\s)@browser(?:\b|$)/i;

function normalizePromptForBrowserUseMatching(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface BrowserUseMcpProcessConfig {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface BrowserUseDynamicToolSpec {
  readonly namespace: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly deferLoading?: boolean;
}

export function getBrowserUseDynamicToolSpecs(): BrowserUseDynamicToolSpec[] {
  return getBrowserUseToolDefinitions().map(({ name, description, inputSchema }) => ({
    namespace: DPCODE_BROWSER_USE_DYNAMIC_TOOL_NAMESPACE,
    name,
    description,
    inputSchema,
  }));
}

// Builds a per-thread MCP server command that reconnects to the desktop IAB pipe.
export function resolveBrowserUseMcpProcessConfig(input: {
  readonly provider: string;
  readonly threadId: ThreadId;
}): BrowserUseMcpProcessConfig {
  const entrypoint = process.argv[1] ?? "";
  return {
    command: process.execPath,
    args: [...(entrypoint ? [entrypoint] : []), "browser-use-mcp"],
    env: {
      DPCODE_BROWSER_USE_SESSION_ID: `${input.provider}:${input.threadId}`,
    },
  };
}

// Adds a short browser-tool reminder without burying the user's actual task.
export function withBrowserUsePromptHint(text: string): string {
  return `${DPCODE_BROWSER_USE_PROVIDER_PROMPT}\n\n${text}`;
}

// Detects turns that should be routed to the live in-app browser instead of web search.
export function promptLooksLikeBrowserUseTask(text: string): boolean {
  const normalized = normalizePromptForBrowserUseMatching(text);
  if (normalized.length === 0) {
    return false;
  }
  if (BROWSER_TAG_PATTERN.test(text)) {
    return true;
  }
  const mentionsBrowser = BROWSER_SCOPE_PATTERNS.some((pattern) => normalized.includes(pattern));
  const asksBrowserAction = BROWSER_ACTION_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
  if (mentionsBrowser && asksBrowserAction) {
    return true;
  }
  return URL_PATTERN.test(text) && mentionsBrowser;
}

// Codex gets the tools natively; this hint keeps browser turns off web search/plugin paths.
export function withCodexBrowserUsePromptHint(text: string): string {
  if (!promptLooksLikeBrowserUseTask(text)) {
    return text;
  }
  return `${CODEX_BROWSER_USE_ROUTING_PROMPT}\n\n${text}`;
}
