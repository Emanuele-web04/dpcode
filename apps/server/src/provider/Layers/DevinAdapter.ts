/**
 * DevinAdapterLive - Direct Devin CLI one-shot provider adapter.
 *
 * Launches `devin -p -- <prompt>` directly, optionally with `--model <model>`.
 *
 * @module DevinAdapterLive
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import {
  EventId,
  type ProviderComposerCapabilities,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";

const PROVIDER = "devin" as const;

export interface DevinCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface DevinAdapterLiveOptions {
  readonly runCommand?: (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
  }) => Effect.Effect<DevinCommandResult, ProviderAdapterRequestError>;
}

interface DevinTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface DevinSessionContext {
  session: ProviderSession;
  readonly binaryPath: string;
  readonly turns: DevinTurnSnapshot[];
}

export function buildDevinPromptArgs(input: {
  readonly prompt: string;
  readonly model?: string | null | undefined;
}): string[] {
  const model = input.model?.trim();
  return model ? ["--model", model, "-p", "--", input.prompt] : ["-p", "--", input.prompt];
}

function nowIso(): string {
  return new Date().toISOString();
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

function runDevinCommand(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
}): Effect.Effect<DevinCommandResult, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: () =>
      new Promise<DevinCommandResult>((resolve, reject) => {
        const child = spawn(input.command, [...input.args], {
          cwd: input.cwd,
          shell: false,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (code) =>
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code: code ?? 1,
          }),
        );
      }),
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "cli.spawn",
        detail: toMessage(cause, "Failed to spawn Devin CLI."),
        cause,
      }),
  });
}

function makeBaseEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
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
    ...(input.itemId ? { itemId: input.itemId } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "devin.cli.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function makeProviderAdapter(options?: DevinAdapterLiveOptions) {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, DevinSessionContext>();
    const runCommand = options?.runCommand ?? runDevinCommand;

    const publish = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const getContext = (threadId: ThreadId, operation: string) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((context) =>
          context
            ? Effect.succeed(context)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
        ),
        Effect.withSpan(`devin.${operation}.getContext`),
      );

    const startSession: DevinAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        const binaryPath = input.providerOptions?.devin?.binaryPath?.trim() || "devin";
        const now = nowIso();
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(model ? { model } : {}),
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(input.threadId, {
          session,
          binaryPath,
          turns: [],
        });

        yield* publish({
          ...makeBaseEvent({ threadId: input.threadId }),
          type: "session.started",
          payload: { message: "Devin CLI session ready." },
        });
        yield* publish({
          ...makeBaseEvent({ threadId: input.threadId }),
          type: "thread.started",
          payload: { providerThreadId: String(input.threadId) },
        });
        return session;
      });

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* getContext(input.threadId, "sendTurn");
        const prompt = input.input?.trim();
        if (!prompt) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Devin requires a non-empty prompt.",
            }),
          );
        }

        const turnId = TurnId.makeUnsafe(`devin-turn-${randomUUID()}`);
        const assistantItemId = RuntimeItemId.makeUnsafe(`devin-assistant-${randomUUID()}`);
        const model =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.model
            : context.session.model;
        const args = buildDevinPromptArgs({ prompt, model });
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: nowIso(),
        };

        yield* publish({
          ...makeBaseEvent({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: model ? { model } : {},
        });

        const result = yield* runCommand({
          command: context.binaryPath,
          args,
          ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        });

        const combinedOutput = result.stdout.trim() || result.stderr.trim();
        if (result.code !== 0) {
          const message = combinedOutput || `Devin CLI exited with code ${String(result.code)}.`;
          context.session = {
            ...context.session,
            status: "error",
            updatedAt: nowIso(),
            lastError: message,
          };
          yield* publish({
            ...makeBaseEvent({
              threadId: input.threadId,
              turnId,
              raw: { args, code: result.code, stderr: result.stderr },
            }),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
            },
          });
          yield* publish({
            ...makeBaseEvent({ threadId: input.threadId, turnId }),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: message,
            },
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cli.print",
              detail: message,
            }),
          );
        }

        if (combinedOutput.length > 0) {
          yield* publish({
            ...makeBaseEvent({ threadId: input.threadId, turnId, itemId: assistantItemId }),
            type: "item.started",
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              title: "Devin",
            },
          });
          yield* publish({
            ...makeBaseEvent({ threadId: input.threadId, turnId, itemId: assistantItemId }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: combinedOutput,
            },
          });
          yield* publish({
            ...makeBaseEvent({ threadId: input.threadId, turnId, itemId: assistantItemId }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Devin",
              detail: combinedOutput,
            },
          });
        }

        context.turns.push({
          id: turnId,
          items: combinedOutput.length > 0 ? [{ type: "assistant", text: combinedOutput }] : [],
        });
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = context.session;
        context.session = {
          ...sessionWithoutActiveTurn,
          status: "ready",
          updatedAt: nowIso(),
        };
        yield* publish({
          ...makeBaseEvent({
            threadId: input.threadId,
            turnId,
            raw: { args, code: result.code },
          }),
          type: "turn.completed",
          payload: {
            state: "completed",
            stopReason: "completed",
          },
        });

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const unsupported = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: "This Devin CLI adapter supports one-shot prompt execution only.",
        }),
      );

    const adapter: DevinAdapterShape = {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn: () => unsupported("interruptTurn"),
      respondToRequest: () => unsupported("respondToRequest"),
      respondToUserInput: () => unsupported("respondToUserInput"),
      stopSession: (threadId) =>
        Effect.sync(() => {
          const context = sessions.get(threadId);
          if (context) {
            context.session = {
              ...context.session,
              status: "closed",
              updatedAt: nowIso(),
            };
          }
          sessions.delete(threadId);
        }),
      listSessions: () => Effect.sync(() => Array.from(sessions.values(), (ctx) => ctx.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        getContext(threadId, "readThread").pipe(
          Effect.map((context) => ({
            threadId,
            turns: context.turns,
            ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
          })),
        ),
      rollbackThread: () => unsupported("rollbackThread"),
      stopAll: () =>
        Effect.sync(() => {
          sessions.clear();
        }),
      streamEvents: Stream.fromQueue(events),
      getComposerCapabilities: () =>
        Effect.succeed({
          provider: PROVIDER,
          supportsSkillMentions: false,
          supportsSkillDiscovery: false,
          supportsNativeSlashCommandDiscovery: false,
          supportsPluginMentions: false,
          supportsPluginDiscovery: false,
          supportsRuntimeModelList: true,
        } satisfies ProviderComposerCapabilities),
      listModels: () =>
        Effect.succeed({
          models: [
            { slug: "swe", name: "SWE" },
            { slug: "opus", name: "Opus" },
            { slug: "sonnet", name: "Sonnet" },
            { slug: "gpt", name: "GPT" },
            { slug: "codex", name: "Codex" },
            { slug: "gemini", name: "Gemini" },
          ],
          source: "devin",
          cached: true,
        }),
    };

    return adapter;
  });
}

export const makeDevinAdapterLive = (options?: DevinAdapterLiveOptions) =>
  Layer.effect(DevinAdapter, makeProviderAdapter(options));

export const DevinAdapterLive = makeDevinAdapterLive();
