import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import {
  EventId,
  type PiThinkingLevel,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = "pi" as const;
const DEFAULT_PI_MODEL = "openai/gpt-5";
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

interface PiModelLike {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
}

interface PiModelRegistryLike {
  readonly getAvailable: () => PiModelLike[];
  readonly find: (provider: string, modelId: string) => PiModelLike | undefined;
}

interface PiSourceInfoLike {
  readonly path?: string;
  readonly source?: string;
  readonly scope?: string;
}

interface PiSkillLike {
  readonly name: string;
  readonly description?: string;
  readonly filePath: string;
  readonly sourceInfo?: PiSourceInfoLike;
  readonly disableModelInvocation?: boolean;
}

interface PiPromptTemplateLike {
  readonly name: string;
  readonly description?: string;
}

interface PiRegisteredCommandLike {
  readonly name: string;
  readonly invocationName?: string;
  readonly description?: string;
}

interface PiExtensionLike {
  readonly commands?: Map<string, PiRegisteredCommandLike>;
}

interface PiResourceLoaderLike {
  readonly getSkills: () => {
    readonly skills: PiSkillLike[];
    readonly diagnostics?: readonly unknown[];
  };
  readonly getPrompts: () => {
    readonly prompts: PiPromptTemplateLike[];
    readonly diagnostics?: readonly unknown[];
  };
  readonly getExtensions: () => {
    readonly extensions: PiExtensionLike[];
    readonly errors?: readonly unknown[];
  };
  readonly reload: () => Promise<void>;
}

interface PiServicesLike {
  readonly cwd: string;
  readonly modelRegistry: PiModelRegistryLike;
  readonly resourceLoader?: PiResourceLoaderLike;
}

interface PiSessionManagerLike {
  readonly getSessionFile: () => string | undefined;
}

interface PiAgentSessionLike {
  readonly sessionManager: PiSessionManagerLike;
  readonly model?: unknown;
  readonly messages?: unknown[];
  readonly state?: {
    readonly messages?: unknown[];
  };
  readonly modelRegistry?: PiModelRegistryLike;
  readonly resourceLoader?: PiResourceLoaderLike;
  readonly promptTemplates?: ReadonlyArray<PiPromptTemplateLike>;
  readonly extensionRunner?: {
    readonly getRegisteredCommands: () => ReadonlyArray<PiRegisteredCommandLike>;
  };
  readonly subscribe: (listener: (event: AgentSessionEvent | unknown) => void) => () => void;
  readonly prompt: (
    text: string,
    options?: {
      readonly images?: ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;
      readonly preflightResult?: (success: boolean) => void;
    },
  ) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly dispose: () => void;
  readonly setModel: (model: unknown) => Promise<void>;
  readonly setThinkingLevel: (level: PiThinkingLevel) => void;
  readonly bindExtensions?: (bindings: Record<string, never>) => Promise<void>;
  readonly compact?: () => Promise<unknown>;
  readonly getContextUsage?: () => PiContextUsageLike | undefined;
  readonly getSessionStats?: () => PiSessionStatsLike;
}

interface PiRuntimeShape {
  readonly createServices: (input: { readonly cwd: string }) => Promise<PiServicesLike>;
  readonly createSessionFromServices: (input: {
    readonly services: PiServicesLike;
    readonly sessionManager: unknown;
    readonly model?: unknown;
    readonly thinkingLevel?: PiThinkingLevel;
  }) => Promise<{ readonly session: PiAgentSessionLike }>;
  readonly createSessionManager: (cwd: string) => unknown;
  readonly openSessionManager: (sessionFile: string) => unknown;
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly runtime?: PiRuntimeShape;
}

interface PiTrackedToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly itemType: ToolLifecycleItemType;
  readonly args?: unknown;
}

interface PiContextUsageLike {
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly percent: number | null;
}

interface PiSessionStatsLike {
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly contextUsage?: PiContextUsageLike;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly piSession: PiAgentSessionLike;
  readonly sessionScope: Scope.Scope;
  unsubscribe: (() => void) | null;
  activeTurnId: TurnId | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeToolCalls: Map<string, PiTrackedToolCall>;
  lastEmittedContextWindowKey: string | undefined;
  lastEmittedTokenUsageKey: string | undefined;
  stopped: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown, fallback = "Pi request failed."): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return fallback;
}

function titleCaseProvider(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function parsePiModelSlug(slug: string | undefined): { provider: string; id: string } | null {
  const trimmed = slug?.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator >= trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

function isPiModelLike(value: unknown): value is PiModelLike {
  return (
    !!value &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "id" in value &&
    typeof value.id === "string"
  );
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function readPiModelContextWindow(model: unknown): number | undefined {
  return model && typeof model === "object" && "contextWindow" in model
    ? asPositiveInteger((model as { readonly contextWindow?: unknown }).contextWindow)
    : undefined;
}

function readPiContextUsage(
  piSession: PiAgentSessionLike,
): { usage: PiContextUsageLike; stats?: PiSessionStatsLike | undefined } | undefined {
  const stats = piSession.getSessionStats?.();
  const usage = stats?.contextUsage ?? piSession.getContextUsage?.();
  const contextWindow = asPositiveInteger(usage?.contextWindow);
  if (!usage || contextWindow === undefined) {
    return undefined;
  }
  return {
    usage: {
      tokens: asNonNegativeInteger(usage.tokens) ?? null,
      contextWindow,
      percent:
        typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null,
    },
    ...(stats ? { stats } : {}),
  };
}

function normalizePiTokenUsage(input: {
  usage: PiContextUsageLike;
  stats?: PiSessionStatsLike | undefined;
}): ThreadTokenUsageSnapshot | undefined {
  const usedTokens = asNonNegativeInteger(input.usage.tokens);
  const maxTokens = asPositiveInteger(input.usage.contextWindow);
  if (usedTokens === undefined || usedTokens <= 0 || maxTokens === undefined) {
    return undefined;
  }

  const statsTokens = input.stats?.tokens;
  const inputTokens = asNonNegativeInteger(statsTokens?.input);
  const outputTokens = asNonNegativeInteger(statsTokens?.output);
  const cacheReadTokens = asNonNegativeInteger(statsTokens?.cacheRead);
  const cacheWriteTokens = asNonNegativeInteger(statsTokens?.cacheWrite);
  const totalProcessedTokens = asNonNegativeInteger(statsTokens?.total);
  const cachedInputTokens =
    cacheReadTokens !== undefined || cacheWriteTokens !== undefined
      ? (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
      : undefined;

  return {
    usedTokens,
    maxTokens,
    ...(totalProcessedTokens !== undefined ? { totalProcessedTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    lastUsedTokens: usedTokens,
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    compactsAutomatically: true,
  };
}

function buildPiTokenUsageKey(usage: ThreadTokenUsageSnapshot): string {
  return [
    usage.usedTokens,
    usage.totalProcessedTokens ?? "",
    usage.maxTokens ?? "",
    usage.inputTokens ?? "",
    usage.cachedInputTokens ?? "",
    usage.outputTokens ?? "",
  ].join(":");
}

function resolveResumeSessionFile(resumeCursor: unknown): string | undefined {
  if (
    resumeCursor &&
    typeof resumeCursor === "object" &&
    "sessionFile" in resumeCursor &&
    typeof resumeCursor.sessionFile === "string" &&
    resumeCursor.sessionFile.trim().length > 0
  ) {
    return resumeCursor.sessionFile.trim();
  }
  return undefined;
}

function toRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "raw"
> {
  return {
    eventId: EventId.makeUnsafe(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: toRuntimeItemId(input.itemId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "pi.sdk.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function updateProviderSession(
  context: PiSessionContext,
  patch: Partial<ProviderSession>,
  options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
): ProviderSession {
  const next: Record<string, unknown> = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  };
  if (options?.clearActiveTurnId) {
    delete next.activeTurnId;
  }
  if (options?.clearLastError) {
    delete next.lastError;
  }
  context.session = next as ProviderSession;
  return context.session;
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, PiSessionContext>,
  threadId: ThreadId,
): PiSessionContext {
  const context = sessions.get(threadId);
  if (!context) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (context.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return context;
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  switch (toolName.toLowerCase()) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    case "read":
    case "grep":
    case "find":
    case "ls":
    default:
      return "dynamic_tool_call";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function piCommandDescriptor(
  name: string,
  description: unknown,
): ProviderListCommandsResult["commands"][number] {
  const descriptor: { name: string; description?: string } = { name };
  const trimmedDescription = asTrimmedString(description);
  if (trimmedDescription) {
    descriptor.description = trimmedDescription;
  }
  return descriptor;
}

function firstTrimmedString(
  record: Record<string, unknown> | undefined,
  keys: ReadonlyArray<string>,
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function truncatePiToolTitlePart(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 96 ? `${singleLine.slice(0, 93).trimEnd()}...` : singleLine;
}

function humanizePiToolName(toolName: string): string {
  const normalized = toolName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Tool";
  }
  return normalized
    .split(" ")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function piToolPath(args: unknown): string | undefined {
  return firstTrimmedString(asRecord(args), [
    "path",
    "filePath",
    "file_path",
    "filename",
    "relativePath",
  ]);
}

function piToolPattern(args: unknown): string | undefined {
  return firstTrimmedString(asRecord(args), ["pattern", "query", "glob"]);
}

function piToolCommand(args: unknown): string | undefined {
  return firstTrimmedString(asRecord(args), ["command", "cmd"]);
}

function piToolDisplayTitle(toolName: string, args: unknown): string {
  const normalizedToolName = toolName.toLowerCase();
  const path = piToolPath(args);
  const pattern = piToolPattern(args);
  switch (normalizedToolName) {
    case "read":
      return path ? `Read ${truncatePiToolTitlePart(path)}` : "Read";
    case "ls":
      return path ? `List ${truncatePiToolTitlePart(path)}` : "List";
    case "grep": {
      const target = path ?? firstTrimmedString(asRecord(args), ["glob"]);
      if (pattern && target) {
        return `Search ${truncatePiToolTitlePart(pattern)} in ${truncatePiToolTitlePart(target)}`;
      }
      if (pattern) {
        return `Search ${truncatePiToolTitlePart(pattern)}`;
      }
      return target ? `Search ${truncatePiToolTitlePart(target)}` : "Search";
    }
    case "find": {
      if (pattern && path) {
        return `Find ${truncatePiToolTitlePart(pattern)} in ${truncatePiToolTitlePart(path)}`;
      }
      if (pattern) {
        return `Find ${truncatePiToolTitlePart(pattern)}`;
      }
      return path ? `Find ${truncatePiToolTitlePart(path)}` : "Find";
    }
    case "edit":
      return path ? `Edit ${truncatePiToolTitlePart(path)}` : "Edit";
    case "write":
      return path ? `Write ${truncatePiToolTitlePart(path)}` : "Write";
    case "bash":
      return "Run command";
    default:
      return humanizePiToolName(toolName);
  }
}

function buildPiToolLifecycleData(input: {
  readonly toolName: string;
  readonly args?: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
}): Record<string, unknown> {
  const normalizedToolName = input.toolName.toLowerCase();
  const data: Record<string, unknown> = {
    toolName: input.toolName,
  };
  if (input.args !== undefined) {
    data.args = input.args;
  }
  const command = piToolCommand(input.args);
  if (command) {
    data.command = command;
  }
  const path = piToolPath(input.args);
  const pattern = piToolPattern(input.args);
  if (path || pattern) {
    data.nativeTool = {
      name: normalizedToolName,
      ...(path ? { path } : {}),
      ...(pattern ? { pattern } : {}),
    };
  }
  if ((normalizedToolName === "edit" || normalizedToolName === "write") && path) {
    data.path = path;
    data.files = [{ path }];
  }
  if (input.partialResult !== undefined) {
    data.partialResult = input.partialResult;
  }
  if (input.result !== undefined) {
    data.result = input.result;
  }
  return data;
}

function buildPiToolDetail(input: {
  readonly toolName: string;
  readonly args?: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}): string | undefined {
  const command = piToolCommand(input.args);
  if (command) {
    return command;
  }
  if (input.isError) {
    return detailFromUnknown(input.result);
  }
  if (input.partialResult !== undefined) {
    return detailFromUnknown(input.partialResult);
  }
  const normalizedToolName = input.toolName.toLowerCase();
  if (normalizedToolName === "edit") {
    const diff = firstTrimmedString(asRecord(input.result), ["diff", "patch"]);
    if (diff) {
      return diff;
    }
  }
  return undefined;
}

function buildPiToolLifecyclePayload(input: {
  readonly toolName: string;
  readonly itemType: ToolLifecycleItemType;
  readonly status: "inProgress" | "completed" | "failed";
  readonly args?: unknown;
  readonly partialResult?: unknown;
  readonly result?: unknown;
  readonly isError?: boolean;
}) {
  const detail = buildPiToolDetail(input);
  return {
    itemType: input.itemType,
    status: input.status,
    title: piToolDisplayTitle(input.toolName, input.args),
    ...(detail ? { detail } : {}),
    data: buildPiToolLifecycleData(input),
  };
}

function detailFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveTurnSnapshot(
  context: PiSessionContext,
  turnId: TurnId,
): { id: TurnId; items: Array<unknown> } {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }
  const created = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(context: PiSessionContext, item: unknown): void {
  if (!context.activeTurnId) {
    return;
  }
  resolveTurnSnapshot(context, context.activeTurnId).items.push(item);
}

function buildPiThreadSnapshot(input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<unknown>;
  readonly cwd?: string | null;
}) {
  return {
    threadId: input.threadId,
    turns: input.messages.map((message, index) => ({
      id: TurnId.makeUnsafe(`pi-message-${index}`),
      items: [message],
    })),
    cwd: input.cwd ?? null,
  };
}

function toProviderModelDescriptor(model: PiModelLike): ProviderListModelsResult["models"][number] {
  const slug = `${model.provider}/${model.id}`;
  return {
    slug,
    name: `${model.provider}/${model.name?.trim() || model.id}`,
    upstreamProviderId: model.provider,
    upstreamProviderName: titleCaseProvider(model.provider),
    ...(model.reasoning
      ? {
          supportedReasoningEfforts: [
            { value: "off", label: "Off" },
            { value: "minimal", label: "Minimal" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High" },
          ],
          defaultReasoningEffort: "medium",
        }
      : {}),
  };
}

function piSourceScope(sourceInfo: PiSourceInfoLike | undefined): string | undefined {
  return asTrimmedString(sourceInfo?.scope) ?? asTrimmedString(sourceInfo?.source);
}

function toPiSkillDescriptor(skill: PiSkillLike): ProviderListSkillsResult["skills"][number] {
  const description = asTrimmedString(skill.description);
  const scope = piSourceScope(skill.sourceInfo);
  return {
    name: skill.name,
    ...(description ? { description } : {}),
    path: skill.filePath,
    enabled: true,
    ...(scope ? { scope } : {}),
    interface: {
      displayName: skill.name,
      ...(description ? { shortDescription: description } : {}),
    },
    ...(skill.disableModelInvocation === true
      ? { dependencies: { disableModelInvocation: true } }
      : {}),
  };
}

function uniquePiCommandDescriptors(
  commands: ReadonlyArray<ProviderListCommandsResult["commands"][number]>,
): ProviderListCommandsResult["commands"] {
  const seen = new Set<string>();
  const unique: Array<ProviderListCommandsResult["commands"][number]> = [];
  for (const command of commands) {
    const normalizedName = command.name.trim();
    if (!normalizedName || seen.has(normalizedName)) {
      continue;
    }
    seen.add(normalizedName);
    unique.push(command);
  }
  return unique.toSorted((left, right) => left.name.localeCompare(right.name));
}

function resolvePiExtensionCommandsFromLoader(
  resourceLoader: PiResourceLoaderLike,
): ProviderListCommandsResult["commands"] {
  const commands: PiRegisteredCommandLike[] = [];
  const counts = new Map<string, number>();
  for (const extension of resourceLoader.getExtensions().extensions) {
    for (const command of extension.commands?.values() ?? []) {
      commands.push(command);
      counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    }
  }

  const seen = new Map<string, number>();
  const takenInvocationNames = new Set<string>();
  return commands.map((command) => {
    const occurrence = (seen.get(command.name) ?? 0) + 1;
    seen.set(command.name, occurrence);
    let invocationName =
      (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;
    if (takenInvocationNames.has(invocationName)) {
      let suffix = occurrence;
      do {
        suffix += 1;
        invocationName = `${command.name}:${suffix}`;
      } while (takenInvocationNames.has(invocationName));
    }
    takenInvocationNames.add(invocationName);
    return piCommandDescriptor(invocationName, command.description);
  });
}

function listPiCommandsFromSources(input: {
  readonly resourceLoader?: PiResourceLoaderLike | undefined;
  readonly promptTemplates?: ReadonlyArray<PiPromptTemplateLike> | undefined;
  readonly extensionCommands?: ReadonlyArray<PiRegisteredCommandLike> | undefined;
}): ProviderListCommandsResult["commands"] {
  const extensionCommands = input.extensionCommands
    ? input.extensionCommands.map((command) =>
        piCommandDescriptor(command.invocationName ?? command.name, command.description),
      )
    : input.resourceLoader
      ? resolvePiExtensionCommandsFromLoader(input.resourceLoader)
      : [];

  const promptTemplates = input.promptTemplates ?? input.resourceLoader?.getPrompts().prompts ?? [];
  const promptCommands = promptTemplates.map((template) =>
    piCommandDescriptor(template.name, template.description),
  );

  return uniquePiCommandDescriptors([...extensionCommands, ...promptCommands]);
}

function makeDefaultPiRuntime(): PiRuntimeShape {
  return {
    createServices: (input) => createAgentSessionServices({ cwd: input.cwd }),
    createSessionFromServices: (input) =>
      createAgentSessionFromServices({
        services: input.services as Parameters<
          typeof createAgentSessionFromServices
        >[0]["services"],
        sessionManager: input.sessionManager as Parameters<
          typeof createAgentSessionFromServices
        >[0]["sessionManager"],
        ...(input.model ? { model: input.model as never } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      }) as unknown as Promise<{ readonly session: PiAgentSessionLike }>,
    createSessionManager: (cwd) => SessionManager.create(cwd),
    openSessionManager: (sessionFile) => SessionManager.open(sessionFile),
  };
}

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(
    PiAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const runtime = options?.runtime ?? makeDefaultPiRuntime();
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
          : undefined);
      const managedNativeEventLogger =
        options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, PiSessionContext>();

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopPiContext(context)), {
            concurrency: "unbounded",
            discard: true,
          });
          if (managedNativeEventLogger) {
            yield* managedNativeEventLogger.close();
          }
        }),
      );

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

      const writeNativeEventBestEffort = (threadId: ThreadId, event: Record<string, unknown>) =>
        nativeEventLogger
          ? nativeEventLogger
              .write({ observedAt: nowIso(), event }, threadId)
              .pipe(Effect.catchCause(() => Effect.void))
          : Effect.void;

      const emitPiContextWindowConfigured = Effect.fn("emitPiContextWindowConfigured")(function* (
        context: PiSessionContext,
        raw?: unknown,
      ) {
        const contextWindow =
          readPiContextUsage(context.piSession)?.usage.contextWindow ??
          readPiModelContextWindow(context.piSession.model);
        if (contextWindow === undefined) {
          return;
        }
        const key = String(contextWindow);
        if (key === context.lastEmittedContextWindowKey) {
          return;
        }
        context.lastEmittedContextWindowKey = key;
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            raw,
          }),
          type: "session.configured",
          payload: {
            config: {
              contextWindow,
            },
          },
        });
      });

      const emitPiTokenUsage = Effect.fn("emitPiTokenUsage")(function* (
        context: PiSessionContext,
        raw?: unknown,
      ) {
        const usageInput = readPiContextUsage(context.piSession);
        if (!usageInput) {
          return;
        }
        const usage = normalizePiTokenUsage(usageInput);
        if (!usage) {
          return;
        }
        const usageKey = buildPiTokenUsageKey(usage);
        if (usageKey === context.lastEmittedTokenUsageKey) {
          return;
        }
        context.lastEmittedTokenUsageKey = usageKey;
        yield* emit({
          ...buildEventBase({
            threadId: context.session.threadId,
            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
            raw,
          }),
          type: "thread.token-usage.updated",
          payload: {
            usage,
          },
        });
      });

      const stopPiContext = Effect.fn("stopPiContext")(function* (context: PiSessionContext) {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        context.unsubscribe?.();
        context.unsubscribe = null;
        yield* Effect.promise(() => context.piSession.abort()).pipe(Effect.ignore);
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        yield* Effect.sync(() => context.piSession.dispose()).pipe(Effect.ignore);
      });

      const failActivePiTurn = Effect.fn("failActivePiTurn")(function* (input: {
        readonly context: PiSessionContext;
        readonly turnId: TurnId;
        readonly detail: string;
        readonly cause?: unknown;
      }) {
        if (input.context.stopped || input.context.activeTurnId !== input.turnId) {
          return;
        }
        input.context.activeTurnId = undefined;
        input.context.activeToolCalls.clear();
        updateProviderSession(
          input.context,
          {
            status: "ready",
            lastError: input.detail,
          },
          { clearActiveTurnId: true },
        );
        yield* emit({
          ...buildEventBase({
            threadId: input.context.session.threadId,
            turnId: input.turnId,
          }),
          type: "turn.aborted",
          payload: {
            reason: input.detail,
          },
        });
        if (input.cause !== undefined) {
          yield* emit({
            ...buildEventBase({
              threadId: input.context.session.threadId,
              turnId: input.turnId,
              raw: input.cause,
            }),
            type: "runtime.error",
            payload: {
              message: input.detail,
              data: input.cause,
            },
          });
        }
      });

      const handlePiEvent = Effect.fn("handlePiEvent")(function* (
        context: PiSessionContext,
        event: AgentSessionEvent | unknown,
      ) {
        if (!event || typeof event !== "object" || !("type" in event)) {
          return;
        }

        const typedEvent = event as Record<string, unknown> & { type: string };
        const turnId = context.activeTurnId;
        yield* writeNativeEventBestEffort(context.session.threadId, {
          provider: PROVIDER,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          type: typedEvent.type,
          payload: typedEvent,
        });

        switch (typedEvent.type) {
          case "message_update": {
            const assistantMessageEvent = typedEvent.assistantMessageEvent as
              | { type?: unknown; delta?: unknown; contentIndex?: unknown }
              | undefined;
            if (!assistantMessageEvent) {
              break;
            }
            const eventType = assistantMessageEvent.type;
            if (eventType !== "text_delta" && eventType !== "thinking_delta") {
              break;
            }
            const delta = assistantMessageEvent.delta;
            if (typeof delta !== "string" || delta.length === 0) {
              break;
            }
            yield* emit({
              ...buildEventBase({ threadId: context.session.threadId, turnId, raw: typedEvent }),
              type: "content.delta",
              payload: {
                streamKind: eventType === "thinking_delta" ? "reasoning_text" : "assistant_text",
                delta,
                ...(typeof assistantMessageEvent.contentIndex === "number"
                  ? { contentIndex: assistantMessageEvent.contentIndex }
                  : {}),
              },
            });
            break;
          }

          case "tool_execution_start": {
            const toolCallId = String(typedEvent.toolCallId ?? randomUUID());
            const toolName = String(typedEvent.toolName ?? "tool");
            const itemType = toToolLifecycleItemType(toolName);
            context.activeToolCalls.set(toolCallId, {
              id: toolCallId,
              toolName,
              itemType,
              args: typedEvent.args,
            });
            appendTurnItem(context, typedEvent);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: toolCallId,
                raw: typedEvent,
              }),
              type: "item.started",
              payload: buildPiToolLifecyclePayload({
                itemType,
                status: "inProgress",
                toolName,
                args: typedEvent.args,
              }),
            });
            break;
          }

          case "tool_execution_update": {
            const toolCallId = String(typedEvent.toolCallId ?? randomUUID());
            const tracked = context.activeToolCalls.get(toolCallId) ?? {
              id: toolCallId,
              toolName: String(typedEvent.toolName ?? "tool"),
              itemType: toToolLifecycleItemType(String(typedEvent.toolName ?? "tool")),
              args: typedEvent.args,
            };
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: toolCallId,
                raw: typedEvent,
              }),
              type: "item.updated",
              payload: buildPiToolLifecyclePayload({
                itemType: tracked.itemType,
                status: "inProgress",
                toolName: tracked.toolName,
                args: typedEvent.args ?? tracked.args,
                partialResult: typedEvent.partialResult,
              }),
            });
            break;
          }

          case "tool_execution_end": {
            const toolCallId = String(typedEvent.toolCallId ?? randomUUID());
            const tracked = context.activeToolCalls.get(toolCallId) ?? {
              id: toolCallId,
              toolName: String(typedEvent.toolName ?? "tool"),
              itemType: toToolLifecycleItemType(String(typedEvent.toolName ?? "tool")),
              args: typedEvent.args,
            };
            context.activeToolCalls.delete(toolCallId);
            yield* emit({
              ...buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: toolCallId,
                raw: typedEvent,
              }),
              type: "item.completed",
              payload: buildPiToolLifecyclePayload({
                itemType: tracked.itemType,
                status: typedEvent.isError === true ? "failed" : "completed",
                toolName: tracked.toolName,
                args: tracked.args,
                result: typedEvent.result,
                isError: typedEvent.isError === true,
              }),
            });
            break;
          }

          case "compaction_start": {
            yield* emit({
              ...buildEventBase({ threadId: context.session.threadId, turnId, raw: typedEvent }),
              type: "item.updated",
              payload: {
                itemType: "context_compaction",
                status: "inProgress",
                detail: "Compacting context",
                data: typedEvent,
              },
            });
            break;
          }

          case "compaction_end": {
            context.lastEmittedTokenUsageKey = undefined;
            yield* emit({
              ...buildEventBase({ threadId: context.session.threadId, turnId, raw: typedEvent }),
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: typedEvent,
              },
            });
            break;
          }

          case "message_end": {
            yield* emitPiContextWindowConfigured(context, typedEvent);
            yield* emitPiTokenUsage(context, typedEvent);
            break;
          }

          case "agent_end": {
            if (!turnId) {
              break;
            }
            yield* emitPiContextWindowConfigured(context, typedEvent);
            yield* emitPiTokenUsage(context, typedEvent);
            context.activeTurnId = undefined;
            context.activeToolCalls.clear();
            updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...buildEventBase({ threadId: context.session.threadId, turnId, raw: typedEvent }),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
            break;
          }

          default:
            break;
        }
      });

      const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Pi adapter cannot start provider '${input.provider}'.`,
            });
          }

          const cwd = input.cwd ?? serverConfig.cwd;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* stopPiContext(existing);
            sessions.delete(input.threadId);
          }

          const services = yield* Effect.promise(() => runtime.createServices({ cwd })).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "createAgentSessionServices",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );
          const selectedModelSlug =
            input.modelSelection?.provider === PROVIDER
              ? input.modelSelection.model
              : DEFAULT_PI_MODEL;
          const parsedModel = parsePiModelSlug(selectedModelSlug);
          const model =
            parsedModel !== null
              ? services.modelRegistry.find(parsedModel.provider, parsedModel.id)
              : undefined;
          if (input.modelSelection?.provider === PROVIDER && (!parsedModel || !model)) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Pi model '${selectedModelSlug}' is not available.`,
            });
          }
          const requestedThinkingLevel =
            input.modelSelection?.provider === PROVIDER
              ? input.modelSelection.options?.thinkingLevel
              : undefined;
          const thinkingLevel =
            requestedThinkingLevel && PI_THINKING_LEVELS.has(requestedThinkingLevel)
              ? requestedThinkingLevel
              : model?.reasoning
                ? "medium"
                : undefined;
          const resumeSessionFile = resolveResumeSessionFile(input.resumeCursor);
          const sessionManager = resumeSessionFile
            ? runtime.openSessionManager(resumeSessionFile)
            : runtime.createSessionManager(cwd);
          const { session: piSession } = yield* Effect.promise(() =>
            runtime.createSessionFromServices({
              services,
              sessionManager,
              ...(model ? { model } : {}),
              ...(thinkingLevel ? { thinkingLevel } : {}),
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "createAgentSessionFromServices",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );

          if (piSession.bindExtensions) {
            yield* Effect.promise(() => piSession.bindExtensions?.({}) ?? Promise.resolve()).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "bindExtensions",
                    detail: errorMessage(cause),
                    cause,
                  }),
              ),
            );
          }

          const createdAt = nowIso();
          const sessionFile = piSession.sessionManager.getSessionFile();
          const sessionScope = yield* Scope.make();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: "full-access",
            cwd,
            ...(selectedModelSlug ? { model: selectedModelSlug } : {}),
            threadId: input.threadId,
            resumeCursor: { ...(sessionFile ? { sessionFile } : {}), cwd },
            createdAt,
            updatedAt: createdAt,
          };
          const context: PiSessionContext = {
            session,
            piSession,
            sessionScope,
            unsubscribe: null,
            activeTurnId: undefined,
            turns: [],
            activeToolCalls: new Map(),
            lastEmittedContextWindowKey: undefined,
            lastEmittedTokenUsageKey: undefined,
            stopped: false,
          };
          context.unsubscribe = piSession.subscribe((event) => {
            Effect.runFork(handlePiEvent(context, event));
          });
          sessions.set(input.threadId, context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: resumeSessionFile ? "Pi session resumed" : "Pi session started",
              resume: session.resumeCursor,
            },
          });
          yield* emitPiContextWindowConfigured(context);
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: sessionFile ? { providerThreadId: sessionFile } : {},
          });

          return session;
        },
      );

      const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        if (context.activeTurnId) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Pi already has an active turn for this session.",
          });
        }
        if (input.interactionMode === "plan") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Pi does not support plan mode.",
          });
        }

        const text = input.input?.trim() ?? "";
        if (!text && (!input.attachments || input.attachments.length === 0)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require text input or at least one attachment.",
          });
        }

        const modelSelection =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection
            : context.session.model
              ? ({ provider: PROVIDER, model: context.session.model } as const)
              : undefined;
        if (modelSelection) {
          const parsedModel = parsePiModelSlug(modelSelection.model);
          if (!parsedModel) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Pi model selection must use the 'provider/model' format.",
            });
          }
          const resolvedModel = context.piSession.modelRegistry?.find(
            parsedModel.provider,
            parsedModel.id,
          );
          const modelToUse =
            resolvedModel ??
            (isPiModelLike(context.piSession.model) &&
            context.piSession.model.provider === parsedModel.provider &&
            context.piSession.model.id === parsedModel.id
              ? context.piSession.model
              : undefined);
          if (!modelToUse) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Pi model '${modelSelection.model}' is not available.`,
            });
          }
          yield* Effect.promise(() => context.piSession.setModel(modelToUse)).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "setModel",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );
          yield* emitPiContextWindowConfigured(context);
          const thinkingLevel = modelSelection.options?.thinkingLevel;
          if (thinkingLevel && PI_THINKING_LEVELS.has(thinkingLevel)) {
            yield* Effect.sync(() => context.piSession.setThinkingLevel(thinkingLevel));
          } else if (modelToUse.reasoning) {
            yield* Effect.sync(() => context.piSession.setThinkingLevel("medium"));
          }
        }

        const images = yield* Effect.forEach(
          (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
          (attachment) =>
            Effect.promise(async () => {
              const filePath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!filePath) {
                throw new Error(`Invalid attachment path for ${attachment.id}.`);
              }
              const data = await readFile(filePath, "base64");
              return { type: "image" as const, data, mimeType: attachment.mimeType };
            }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "loadAttachment",
                detail: errorMessage(cause, "Failed to load Pi image attachment."),
                cause,
              }),
          ),
        );

        const turnId = TurnId.makeUnsafe(`pi-turn-${randomUUID()}`);
        context.activeTurnId = turnId;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            runtimeMode: "full-access",
            ...(modelSelection ? { model: modelSelection.model } : {}),
          },
          { clearLastError: true },
        );
        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(modelSelection?.options?.thinkingLevel
              ? { effort: modelSelection.options.thinkingLevel }
              : {}),
          },
        });

        const promptAccepted = yield* Deferred.make<void, ProviderAdapterRequestError>();
        const acceptPrompt = (accepted: boolean) => {
          const result = accepted
            ? Deferred.succeed(promptAccepted, undefined)
            : Deferred.fail(
                promptAccepted,
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: "Pi rejected the prompt before dispatch.",
                }),
              );
          Effect.runFork(result.pipe(Effect.ignore));
        };
        yield* Effect.promise(() =>
          context.piSession.prompt(text, {
            images,
            preflightResult: acceptPrompt,
          }),
        ).pipe(
          Effect.tap(() => Deferred.succeed(promptAccepted, undefined)),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: errorMessage(cause),
                cause,
              }),
          ),
          Effect.tapError((requestError) =>
            Deferred.fail(promptAccepted, requestError).pipe(
              Effect.zipRight(
                failActivePiTurn({
                  context,
                  turnId,
                  detail: requestError.detail,
                  cause: requestError.cause,
                }),
              ),
              Effect.ignore,
            ),
          ),
          Effect.forkIn(context.sessionScope),
        );

        yield* Deferred.await(promptAccepted).pipe(
          Effect.tapError((requestError) =>
            failActivePiTurn({
              context,
              turnId,
              detail: requestError.detail,
              cause: requestError.cause,
            }),
          ),
        );

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

      const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureSessionContext(sessions, threadId);
          const activeTurnId = turnId ?? context.activeTurnId;
          yield* Effect.promise(() => context.piSession.abort()).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "abort",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );
          context.activeTurnId = undefined;
          updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          if (activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: PiAdapterShape["respondToRequest"] = () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: "Pi has no pending approval requests.",
          }),
        );

      const respondToUserInput: PiAdapterShape["respondToUserInput"] = () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: "Pi has no pending user-input requests.",
          }),
        );

      const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* stopPiContext(context);
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: PiAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: PiAdapterShape["readThread"] = (threadId) =>
        Effect.sync(() => {
          const context = ensureSessionContext(sessions, threadId);
          return buildPiThreadSnapshot({
            threadId,
            messages: context.piSession.messages ?? context.piSession.state?.messages ?? [],
            ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
          });
        });

      const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureSessionContext(sessions, threadId);
          if (numTurns > 0) {
            context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          }
          return yield* readThread(threadId);
        },
      );

      const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
        Effect.gen(function* () {
          const context = ensureSessionContext(sessions, threadId);
          if (!context.piSession.compact) {
            return;
          }
          yield* Effect.promise(() => context.piSession.compact?.() ?? Promise.resolve()).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "compact",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );
        });

      const listModels: NonNullable<PiAdapterShape["listModels"]> = () =>
        Effect.gen(function* () {
          const cwd = serverConfig.cwd;
          const services = yield* Effect.promise(() => runtime.createServices({ cwd })).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "modelRegistry.getAvailable",
                  detail: errorMessage(cause),
                  cause,
                }),
            ),
          );
          return {
            models: services.modelRegistry
              .getAvailable()
              .map(toProviderModelDescriptor)
              .toSorted((left, right) => left.name.localeCompare(right.name)),
            source: "pi-sdk",
            cached: false,
          } satisfies ProviderListModelsResult;
        });

      const listSkills: NonNullable<PiAdapterShape["listSkills"]> = (input) =>
        Effect.gen(function* () {
          const activeContext = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : [...sessions.values()].find((context) => !context.stopped);
          const activeResourceLoader = activeContext?.piSession.resourceLoader;
          const resourceLoader =
            activeResourceLoader ??
            (yield* Effect.promise(() => runtime.createServices({ cwd: input.cwd })).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "skills/list",
                    detail: errorMessage(cause, "Failed to discover Pi skills."),
                    cause,
                  }),
              ),
              Effect.map((services) => services.resourceLoader),
            ));

          if (!resourceLoader) {
            return {
              skills: [],
              source: "pi-sdk",
              cached: false,
            } satisfies ProviderListSkillsResult;
          }
          if (input.forceReload) {
            yield* Effect.promise(() => resourceLoader.reload()).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "skills/reload",
                    detail: errorMessage(cause, "Failed to reload Pi skills."),
                    cause,
                  }),
              ),
            );
          }
          return {
            skills: resourceLoader
              .getSkills()
              .skills.map(toPiSkillDescriptor)
              .toSorted((left, right) => left.name.localeCompare(right.name)),
            source: "pi-sdk",
            cached: false,
          } satisfies ProviderListSkillsResult;
        });

      const listCommands: NonNullable<PiAdapterShape["listCommands"]> = (input) =>
        Effect.gen(function* () {
          const activeContext = input.threadId
            ? sessions.get(ThreadId.makeUnsafe(input.threadId))
            : [...sessions.values()].find((context) => !context.stopped);
          if (activeContext && !activeContext.stopped) {
            const resourceLoader = activeContext.piSession.resourceLoader;
            if (input.forceReload && resourceLoader) {
              yield* Effect.promise(() => resourceLoader.reload()).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "commands/reload",
                      detail: errorMessage(cause, "Failed to reload Pi commands."),
                      cause,
                    }),
                ),
              );
            }
            return {
              commands: listPiCommandsFromSources({
                resourceLoader,
                promptTemplates: activeContext.piSession.promptTemplates,
                extensionCommands: activeContext.piSession.extensionRunner?.getRegisteredCommands(),
              }),
              source: "pi-sdk",
              cached: false,
            } satisfies ProviderListCommandsResult;
          }

          const services = yield* Effect.promise(() =>
            runtime.createServices({ cwd: input.cwd }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "commands/list",
                  detail: errorMessage(cause, "Failed to discover Pi commands."),
                  cause,
                }),
            ),
          );
          if (input.forceReload) {
            yield* Effect.promise(
              () => services.resourceLoader?.reload() ?? Promise.resolve(),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "commands/reload",
                    detail: errorMessage(cause, "Failed to reload Pi commands."),
                    cause,
                  }),
              ),
            );
          }
          return {
            commands: listPiCommandsFromSources({
              resourceLoader: services.resourceLoader,
            }),
            source: "pi-sdk",
            cached: false,
          } satisfies ProviderListCommandsResult;
        });

      const getComposerCapabilities: NonNullable<PiAdapterShape["getComposerCapabilities"]> = () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsThreadCompaction: true,
          supportsThreadImport: false,
        } satisfies ProviderComposerCapabilities);

      const stopAll: PiAdapterShape["stopAll"] = () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopPiContext(context)), {
            concurrency: "unbounded",
            discard: true,
          });
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
          supportsSkillMentions: true,
          supportsSkillDiscovery: true,
          supportsNativeSlashCommandDiscovery: true,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
          supportsTurnSteering: false,
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        compactThread,
        stopAll,
        listModels,
        listCommands,
        listSkills,
        getComposerCapabilities,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies PiAdapterShape;
    }),
  );
}

export const PiAdapterLive = makePiAdapterLive();
