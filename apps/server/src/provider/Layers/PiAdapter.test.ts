import { describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { makePiAdapterLive, type PiAdapterLiveOptions } from "./PiAdapter.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type FakePiEvent = Record<string, unknown> & { type: string };
type FakePiRuntime = NonNullable<PiAdapterLiveOptions["runtime"]>;

function createFakePiRuntime() {
  const modelRegistry = {
    getAvailable: vi.fn(() => [
      {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        contextWindow: 200_000,
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-pi",
        name: "Claude Sonnet Pi",
        reasoning: false,
        contextWindow: 180_000,
      },
    ]),
    find: vi.fn((provider: string, id: string) =>
      modelRegistry.getAvailable().find((model) => model.provider === provider && model.id === id),
    ),
  };
  const unsubscribe = vi.fn();
  const listeners = new Set<(event: FakePiEvent) => void>();
  const sessionManager = {
    getSessionFile: vi.fn(() => "/tmp/pi-session.jsonl"),
  };
  const initialModel = modelRegistry.find("openai", "gpt-5");
  if (!initialModel) {
    throw new Error("Expected fake Pi model to exist.");
  }
  const resourceLoader = {
    getSkills: vi.fn(() => ({
      skills: [
        {
          name: "review-code",
          description: "Review code carefully",
          filePath: "/tmp/pi-skills/review-code/SKILL.md",
          sourceInfo: {
            scope: "project",
            source: "project",
          },
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    })),
    getPrompts: vi.fn(() => ({
      prompts: [
        {
          name: "summarize",
          description: "Summarize the current thread",
        },
      ],
      diagnostics: [],
    })),
    getExtensions: vi.fn(() => ({
      extensions: [
        {
          commands: new Map([
            [
              "release",
              {
                name: "release",
                description: "Prepare a release",
              },
            ],
          ]),
        },
      ],
      errors: [],
    })),
    reload: vi.fn(async () => undefined),
  };
  const session = {
    sessionManager,
    modelRegistry,
    resourceLoader,
    model: initialModel,
    promptTemplates: resourceLoader.getPrompts().prompts,
    extensionRunner: {
      getRegisteredCommands: vi.fn(() => [
        {
          name: "release",
          invocationName: "release",
          description: "Prepare a release",
        },
      ]),
    },
    messages: [
      {
        role: "user",
        content: "hello",
      },
    ],
    subscribe: vi.fn((listener: (event: FakePiEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    }),
    prompt: vi.fn(
      async (
        _text?: string,
        _options?: { readonly preflightResult?: (success: boolean) => void },
      ) => {
        for (const listener of listeners) {
          listener({ type: "agent_start" });
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Hello from Pi",
            },
          });
          listener({ type: "message_end" });
          listener({ type: "agent_end" });
        }
      },
    ),
    steer: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    setModel: vi.fn(async (model: unknown) => {
      if (model && typeof model === "object") {
        session.model = model as typeof initialModel;
      }
    }),
    setThinkingLevel: vi.fn(),
    compact: vi.fn(async () => undefined),
    getContextUsage: vi.fn(() => ({
      tokens: 12_345,
      contextWindow: 200_000,
      percent: 6.1725,
    })),
    getSessionStats: vi.fn(() => ({
      tokens: {
        input: 10_000,
        output: 2_000,
        cacheRead: 300,
        cacheWrite: 45,
        total: 12_345,
      },
      contextUsage: {
        tokens: 12_345,
        contextWindow: 200_000,
        percent: 6.1725,
      },
    })),
  };
  const runtime: FakePiRuntime = {
    createServices: vi.fn(async (input) => ({
      cwd: input.cwd,
      modelRegistry,
      resourceLoader,
    })),
    createSessionFromServices: vi.fn(async () => ({ session })),
    createSessionManager: vi.fn(() => ({ kind: "create" })),
    openSessionManager: vi.fn((sessionFile: string) => ({ kind: "open", sessionFile })),
  };

  return {
    emit: (event: FakePiEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
    modelRegistry,
    runtime,
    session,
    unsubscribe,
  };
}

function setFakeSessionStreaming(session: ReturnType<typeof createFakePiRuntime>["session"]): void {
  (session as typeof session & { isStreaming: boolean }).isStreaming = true;
}

function providePiAdapter(runtime: FakePiRuntime) {
  return makePiAdapterLive({ runtime, verifyBinaryPath: async () => undefined }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("PiAdapter", () => {
  it("starts a full-access ready session and resumes from a session file", async () => {
    const fake = createFakePiRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const started = yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi"),
          runtimeMode: "approval-required",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const resumed = yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi"),
          runtimeMode: "approval-required",
          resumeCursor: {
            sessionFile: "/tmp/existing-pi-session.jsonl",
          },
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        return { resumed, started };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.started).toMatchObject({
      provider: "pi",
      status: "ready",
      runtimeMode: "full-access",
      model: "openai/gpt-5",
      resumeCursor: {
        sessionFile: "/tmp/pi-session.jsonl",
      },
    });
    expect(result.resumed.runtimeMode).toBe("full-access");
    expect(fake.runtime.openSessionManager).toHaveBeenCalledWith("/tmp/existing-pi-session.jsonl");
  });

  it("wraps synchronous Pi session manager failures as provider request errors", async () => {
    const fake = createFakePiRuntime();
    vi.mocked(fake.runtime.createSessionManager).mockImplementation(() => {
      throw new Error("cannot create session file");
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        return yield* Effect.flip(
          adapter.startSession({
            provider: "pi",
            threadId: asThreadId("thread-pi-manager-throws"),
            runtimeMode: "full-access",
          }),
        );
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(error).toMatchObject({
      provider: "pi",
      method: "createSessionManager",
      detail: "cannot create session file",
    });
  });

  it("forwards Pi binary path and records the SDK-selected model when no model is requested", async () => {
    const fake = createFakePiRuntime();

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        return yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-sdk-default"),
          runtimeMode: "full-access",
          providerOptions: {
            pi: {
              binaryPath: "/opt/bin/pi",
            },
          },
        });
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(fake.runtime.createServices).toHaveBeenCalledWith({
      cwd: process.cwd(),
      binaryPath: "/opt/bin/pi",
    });
    expect(fake.runtime.createSessionFromServices).toHaveBeenCalledWith(
      expect.not.objectContaining({ model: expect.anything() }),
    );
    expect(session.model).toBe("openai/gpt-5");
  });

  it("does not pass an unavailable hard-coded fallback model into Pi session creation", async () => {
    const fake = createFakePiRuntime();
    fake.modelRegistry.find.mockImplementation((provider: string, id: string) =>
      provider === "openai" && id === "gpt-5"
        ? undefined
        : fake.modelRegistry
            .getAvailable()
            .find((model) => model.provider === provider && model.id === id),
    );

    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        return yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-missing-default"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(session.model).toBe("openai/gpt-5");
    expect(fake.runtime.createSessionFromServices).toHaveBeenCalledWith(
      expect.not.objectContaining({
        model: expect.anything(),
      }),
    );
  });

  it("expands selected Pi skills and mentions into the prompt text", async () => {
    const fake = createFakePiRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-skills-mentions"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-skills-mentions"),
          input: "review this",
          attachments: [],
          interactionMode: "default",
          skills: [{ name: "review-code", path: "/tmp/pi-skills/review-code/SKILL.md" }],
          mentions: [
            { name: "PiAdapter.ts", path: "apps/server/src/provider/Layers/PiAdapter.ts" },
          ],
        });
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(fake.session.prompt).toHaveBeenCalledWith(
      [
        "/skill:review-code",
        "Referenced files:\n@apps/server/src/provider/Layers/PiAdapter.ts",
        "review this",
      ].join("\n\n"),
      expect.any(Object),
    );
  });

  it("sends a normal turn and maps Pi events to canonical runtime events", async () => {
    const fake = createFakePiRuntime();

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
            options: {
              thinkingLevel: "high",
            },
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi"),
          input: "hello",
          attachments: [],
          interactionMode: "default",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
            options: {
              thinkingLevel: "high",
            },
          },
        });
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        return { collected, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(events.turn.turnId).toMatch(/^pi-turn-/u);
    expect(fake.session.setModel).toHaveBeenCalled();
    expect(fake.session.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(events.collected.map((event: ProviderRuntimeEvent) => event.type)).toEqual([
      "session.started",
      "session.configured",
      "thread.started",
      "turn.started",
      "content.delta",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(events.collected[4]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello from Pi",
      },
    });
    expect(events.collected[5]).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 12345,
          totalProcessedTokens: 12345,
          maxTokens: 200000,
          inputTokens: 10000,
          cachedInputTokens: 345,
          outputTokens: 2000,
          compactsAutomatically: true,
        },
      },
    });
  });

  it("returns after Pi accepts a prompt instead of waiting for agent completion", async () => {
    const fake = createFakePiRuntime();
    let resolvePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-long-running"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-long-running"),
          input: "keep working",
          attachments: [],
          interactionMode: "default",
        });
        const runningSession = (yield* adapter.listSessions()).find(
          (session) => session.threadId === asThreadId("thread-pi-long-running"),
        );

        fake.emit({ type: "agent_start" });
        fake.emit({ type: "agent_end" });
        resolvePrompt?.();
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        return { collected, runningSession, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.turn.turnId).toMatch(/^pi-turn-/u);
    expect(result.runningSession).toMatchObject({
      status: "running",
      activeTurnId: result.turn.turnId,
    });
    expect(result.collected.map((event: ProviderRuntimeEvent) => event.type)).toEqual([
      "session.started",
      "session.configured",
      "thread.started",
      "turn.started",
      "thread.token-usage.updated",
      "turn.completed",
    ]);
  });

  it("steers an active Pi turn", async () => {
    const fake = createFakePiRuntime();
    let resolvePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-steer"),
          runtimeMode: "full-access",
          modelSelection: { provider: "pi", model: "openai/gpt-5" },
        });
        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-steer"),
          input: "start",
          attachments: [],
          interactionMode: "default",
        });
        setFakeSessionStreaming(fake.session);
        const steered = yield* adapter.steerTurn!({
          threadId: asThreadId("thread-pi-steer"),
          input: "actually do this",
          attachments: [],
          interactionMode: "default",
          skills: [{ name: "review-code", path: "/tmp/pi-skills/review-code/SKILL.md" }],
        });
        resolvePrompt?.();
        return { steered, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.steered.turnId).toBe(result.turn.turnId);
    expect(fake.session.steer).toHaveBeenCalledWith(
      ["/skill:review-code", "actually do this"].join("\n\n"),
      [],
    );
  });

  it("queues a Pi follow-up in the active turn", async () => {
    const fake = createFakePiRuntime();
    let resolvePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-follow-up"),
          runtimeMode: "full-access",
          modelSelection: { provider: "pi", model: "openai/gpt-5" },
        });
        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-follow-up"),
          input: "start",
          attachments: [],
          interactionMode: "default",
        });
        setFakeSessionStreaming(fake.session);
        const followedUp = yield* adapter.followUpTurn!({
          threadId: asThreadId("thread-pi-follow-up"),
          input: "after that do this",
          attachments: [],
          interactionMode: "default",
          mentions: [{ name: "notes.md", path: "notes.md" }],
        });
        resolvePrompt?.();
        return { followedUp, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.followedUp.turnId).toBe(result.turn.turnId);
    expect(fake.session.followUp).toHaveBeenCalledWith(
      ["Referenced files:\n@notes.md", "after that do this"].join("\n\n"),
      [],
    );
  });

  it("does not let a stale Pi agent_end complete the next accepted turn", async () => {
    const fake = createFakePiRuntime();
    const resolvePrompts: Array<() => void> = [];
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompts.push(resolve);
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-stale-end"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const firstTurn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-stale-end"),
          input: "start long task",
          attachments: [],
          interactionMode: "default",
        });
        yield* adapter.interruptTurn(asThreadId("thread-pi-stale-end"), firstTurn.turnId);

        const secondTurn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-stale-end"),
          input: "try again",
          attachments: [],
          interactionMode: "default",
        });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "stale response",
          },
        });
        fake.emit({
          type: "tool_execution_start",
          toolCallId: "stale-tool",
          toolName: "read",
          args: { path: "stale.ts" },
        });
        fake.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Invalid stale request.",
            },
          ],
        });
        fake.emit({ type: "agent_end" });
        const runningAfterStaleEnd = (yield* adapter.listSessions()).find(
          (session) => session.threadId === asThreadId("thread-pi-stale-end"),
        );

        fake.emit({ type: "agent_start" });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Recovered response",
          },
        });
        fake.emit({ type: "agent_end" });
        for (const resolve of resolvePrompts) {
          resolve();
        }
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        return { collected, runningAfterStaleEnd, secondTurn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.runningAfterStaleEnd).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
    expect(
      result.collected.filter((event: ProviderRuntimeEvent) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(
      result.collected.filter((event: ProviderRuntimeEvent) => event.type === "runtime.error"),
    ).toHaveLength(0);
    expect(
      result.collected.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
          event.type === "content.delta",
      ),
    ).toHaveLength(1);
    expect(result.collected.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: result.secondTurn.turnId,
    });
  });

  it("ignores stale Pi SDK events captured before a session restart", async () => {
    const fake = createFakePiRuntime();
    const resolvePrompts: Array<() => void> = [];
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompts.push(resolve);
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 13)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-pi-restart-stale-events");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: { provider: "pi", model: "openai/gpt-5" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "first",
          attachments: [],
          interactionMode: "default",
        });
        const staleListener = fake.session.subscribe.mock.calls.at(-1)?.[0] as
          | ((event: FakePiEvent) => void)
          | undefined;
        yield* adapter.stopSession(threadId);

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: { provider: "pi", model: "openai/gpt-5" },
        });
        const secondTurn = yield* adapter.sendTurn({
          threadId,
          input: "second",
          attachments: [],
          interactionMode: "default",
        });

        staleListener?.({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "stale text" },
        });
        staleListener?.({ type: "agent_end" });
        const runningAfterStaleEvents = (yield* adapter.listSessions()).find(
          (session) => session.threadId === threadId,
        );

        fake.emit({ type: "agent_start" });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "fresh text" },
        });
        fake.emit({ type: "message_end" });
        fake.emit({ type: "agent_end" });
        for (const resolve of resolvePrompts) {
          resolve();
        }
        return {
          collected: Array.from(yield* Fiber.join(eventsFiber)),
          runningAfterStaleEvents,
          secondTurn,
        };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.runningAfterStaleEvents).toMatchObject({
      status: "running",
      activeTurnId: result.secondTurn.turnId,
    });
    const contentDeltas = result.collected.filter(
      (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
        event.type === "content.delta",
    );
    expect(contentDeltas.map((event) => event.payload.delta)).toEqual(["fresh text"]);
    expect(result.collected.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: result.secondTurn.turnId,
    });
  });

  it("fails rollback explicitly instead of pretending to rewind Pi SDK state", async () => {
    const fake = createFakePiRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-rollback-unsupported");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: { provider: "pi", model: "openai/gpt-5" },
        });
        const rollback = yield* Effect.exit(adapter.rollbackThread(threadId, 1));
        return rollback;
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result._tag).toBe("Failure");
  });

  it("treats Pi final error messages as aborted turns", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      for (const listener of fake.session.subscribe.mock.calls.map(
        (call) => call[0] as (event: FakePiEvent) => void,
      )) {
        listener({ type: "agent_start" });
        (fake.session.messages as Array<unknown>).push(
          {
            role: "user",
            content: "hello",
          },
          {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Invalid request.",
          },
        );
        listener({ type: "message_end" });
        listener({ type: "agent_end" });
      }
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-final-error"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-final-error"),
          input: "hello",
          attachments: [],
          interactionMode: "default",
        });
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        const session = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === asThreadId("thread-pi-final-error"),
        );
        return { collected, session, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.session).toMatchObject({
      status: "ready",
      lastError: "Invalid request.",
    });
    expect(result.collected.map((event: ProviderRuntimeEvent) => event.type)).toEqual([
      "session.started",
      "session.configured",
      "thread.started",
      "turn.started",
      "thread.token-usage.updated",
      "turn.aborted",
      "runtime.error",
    ]);
    expect(
      result.collected.filter((event: ProviderRuntimeEvent) => event.type === "turn.completed"),
    ).toHaveLength(0);
    expect(result.collected.at(-2)).toMatchObject({
      type: "turn.aborted",
      turnId: result.turn.turnId,
      payload: {
        reason: "Invalid request.",
      },
    });
    expect(result.collected.at(-1)).toMatchObject({
      type: "runtime.error",
      turnId: result.turn.turnId,
      payload: {
        message: "Invalid request.",
      },
    });
  });

  it("keeps a Pi turn active while the SDK auto-retries a retryable agent_end error", async () => {
    const fake = createFakePiRuntime();
    let resolvePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-pi-auto-retry");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "open a pr",
          attachments: [],
          interactionMode: "default",
        });

        fake.emit({ type: "agent_start" });
        fake.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Error Code internal_server_error: stream error",
            },
          ],
        });
        const sessionAfterRetryableEnd = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );

        fake.emit({
          type: "auto_retry_start",
          attempt: 1,
          errorMessage: "Error Code internal_server_error: stream error",
        });
        fake.emit({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Opened the PR.",
          },
        });
        fake.emit({ type: "message_end" });
        fake.emit({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Opened the PR." }],
              stopReason: "stop",
            },
          ],
        });
        resolvePrompt?.();

        const collected = Array.from(yield* Fiber.join(eventsFiber));
        return { collected, sessionAfterRetryableEnd, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.sessionAfterRetryableEnd).toMatchObject({
      status: "running",
      activeTurnId: result.turn.turnId,
    });
    expect(
      result.collected.filter((event: ProviderRuntimeEvent) => event.type === "turn.completed"),
    ).toHaveLength(1);
    expect(result.collected).toContainEqual(
      expect.objectContaining({
        type: "content.delta",
        turnId: result.turn.turnId,
        payload: expect.objectContaining({
          delta: "Opened the PR.",
        }),
      }),
    );
    expect(result.collected.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: result.turn.turnId,
    });
  });

  it("recovers final Pi assistant text when no text deltas were streamed", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({ type: "message_end" });
        listener({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Final answer from Pi." }],
              stopReason: "stop",
            },
          ],
        });
      }
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-pi-final-text-recovery");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "answer without streaming",
          attachments: [],
          interactionMode: "default",
        });

        return {
          collected: Array.from(yield* Fiber.join(eventsFiber)),
          turn,
        };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.collected).toContainEqual(
      expect.objectContaining({
        type: "content.delta",
        turnId: result.turn.turnId,
        payload: expect.objectContaining({
          streamKind: "assistant_text",
          delta: "Final answer from Pi.",
        }),
      }),
    );
    expect(result.collected.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: result.turn.turnId,
    });
  });

  it("recovers final Pi assistant text from turn_end before completing", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({
          type: "turn_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Turn-end answer from Pi." }],
            stopReason: "stop",
          },
        });
        listener({ type: "agent_end" });
      }
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );
        const threadId = asThreadId("thread-pi-turn-end-final-text");

        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "answer at turn_end",
          attachments: [],
          interactionMode: "default",
        });

        return {
          collected: Array.from(yield* Fiber.join(eventsFiber)),
          turn,
        };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.collected).toContainEqual(
      expect.objectContaining({
        type: "content.delta",
        turnId: result.turn.turnId,
        payload: expect.objectContaining({
          streamKind: "assistant_text",
          delta: "Turn-end answer from Pi.",
        }),
      }),
    );
    expect(result.collected.at(-1)).toMatchObject({
      type: "turn.completed",
      turnId: result.turn.turnId,
    });
  });

  it("emits configured Pi context window but skips unknown post-compaction usage", async () => {
    const fake = createFakePiRuntime();
    fake.session.getContextUsage.mockReturnValue({
      tokens: null,
      contextWindow: 200_000,
      percent: null,
    } as never);
    fake.session.getSessionStats.mockReturnValue({
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
      contextUsage: {
        tokens: null,
        contextWindow: 200_000,
        percent: null,
      },
    } as never);

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-null-usage"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-null-usage"),
          input: "hello",
          attachments: [],
          interactionMode: "default",
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(collected.map((event: ProviderRuntimeEvent) => event.type)).toEqual([
      "session.started",
      "session.configured",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.completed",
    ]);
    expect(collected[1]).toMatchObject({
      type: "session.configured",
      payload: {
        config: {
          contextWindow: 200000,
        },
      },
    });
  });

  it("maps Pi native tools to readable lifecycle payloads", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read",
          args: { path: "src/model.ts", offset: 1, limit: 20 },
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "read-1",
          toolName: "read",
          result: "file contents",
          isError: false,
        });
        listener({
          type: "tool_execution_start",
          toolCallId: "bash-1",
          toolName: "bash",
          args: { command: "bun run test apps/server/src/provider/Layers/PiAdapter.test.ts" },
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "bash-1",
          toolName: "bash",
          result: "ok",
          isError: false,
        });
        listener({
          type: "tool_execution_start",
          toolCallId: "edit-1",
          toolName: "edit",
          args: { path: "src/model.ts", edits: [{ oldText: "a", newText: "b" }] },
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "edit-1",
          toolName: "edit",
          result: { diff: "--- a/src/model.ts\n+++ b/src/model.ts" },
          isError: false,
        });
        listener({ type: "agent_end" });
      }
    });

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 11)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-tools"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-tools"),
          input: "inspect files",
          attachments: [],
          interactionMode: "default",
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    const lifecycleEvents = collected.filter(
      (event: ProviderRuntimeEvent) =>
        event.type === "item.started" || event.type === "item.completed",
    );
    expect(lifecycleEvents).toHaveLength(6);
    expect(lifecycleEvents[0]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Read src/model.ts",
        data: {
          toolName: "read",
          args: {
            path: "src/model.ts",
          },
          nativeTool: {
            name: "read",
            path: "src/model.ts",
          },
        },
      },
    });
    expect(lifecycleEvents[1]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Read src/model.ts",
        data: {
          toolName: "read",
          result: "file contents",
        },
      },
    });
    expect(lifecycleEvents[2]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        title: "Run command",
        detail: "bun run test apps/server/src/provider/Layers/PiAdapter.test.ts",
        data: {
          toolName: "bash",
          command: "bun run test apps/server/src/provider/Layers/PiAdapter.test.ts",
        },
      },
    });
    expect(lifecycleEvents[4]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "file_change",
        title: "Edit src/model.ts",
        data: {
          toolName: "edit",
          path: "src/model.ts",
          files: [{ path: "src/model.ts" }],
        },
      },
    });
  });

  it("anchors completed Pi tool rows to their start time when text streams before completion", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({
          type: "tool_execution_start",
          toolCallId: "read-before-text",
          toolName: "read",
          args: { path: "src/model.ts" },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "I checked the file.",
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        listener({
          type: "tool_execution_end",
          toolCallId: "read-before-text",
          toolName: "read",
          result: "file contents",
          isError: false,
        });
        listener({ type: "agent_end" });
      }
    });

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 9)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-tool-order"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-tool-order"),
          input: "inspect files",
          attachments: [],
          interactionMode: "default",
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    const toolStarted = collected.find((event) => event.type === "item.started");
    const textDelta = collected.find((event) => event.type === "content.delta");
    const toolCompleted = collected.find((event) => event.type === "item.completed");

    expect(toolStarted?.createdAt).toBeDefined();
    expect(textDelta?.createdAt).toBeDefined();
    expect(toolCompleted?.createdAt).toBe(toolStarted?.createdAt);
    expect(toolStarted?.createdAt.localeCompare(textDelta?.createdAt ?? "")).toBeLessThan(0);
  });

  it("rejects plan mode and concurrent active turns", async () => {
    const fake = createFakePiRuntime();
    let releasePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementationOnce(async (_text, options) => {
      options?.preflightResult?.(true);
      await new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const planMode = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-pi"),
            input: "hello",
            attachments: [],
            interactionMode: "plan",
          }),
        );
        const firstTurnFiber = yield* adapter
          .sendTurn({
            threadId: asThreadId("thread-pi"),
            input: "hello",
            attachments: [],
            interactionMode: "default",
          })
          .pipe(Effect.forkChild);
        yield* Effect.sleep("10 millis");
        const concurrent = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-pi"),
            input: "again",
            attachments: [],
            interactionMode: "default",
          }),
        );
        releasePrompt?.();
        yield* Fiber.join(firstTurnFiber);
        return { concurrent, planMode };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.planMode._tag).toBe("Failure");
    expect(result.concurrent._tag).toBe("Failure");
  });

  it("rejects a new turn when the Pi SDK is still streaming without an active DP turn", async () => {
    const fake = createFakePiRuntime();
    (fake.session as typeof fake.session & { isStreaming: boolean }).isStreaming = true;

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-sdk-busy");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        return yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "new work",
            attachments: [],
            interactionMode: "default",
          }),
        );
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result._tag).toBe("Failure");
    expect(fake.session.prompt).not.toHaveBeenCalled();
  });

  it("rejects attachment-only Pi turns when none of the attachments are images", async () => {
    const fake = createFakePiRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-non-image-attachment"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        return yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-pi-non-image-attachment"),
            input: "",
            attachments: [
              {
                id: "attachment-1",
                type: "file",
                name: "notes.txt",
                mimeType: "text/plain",
              },
            ] as never,
            interactionMode: "default",
          }),
        );
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result._tag).toBe("Failure");
    expect(fake.session.prompt).not.toHaveBeenCalled();
  });

  it("surfaces the Pi SDK rejection reason when prompt preflight fails", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(false);
      throw new Error("Agent is already processing another prompt.");
    });

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-preflight-reason");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        return yield* Effect.flip(
          adapter.sendTurn({
            threadId,
            input: "new work",
            attachments: [],
            interactionMode: "default",
          }),
        );
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(error).toMatchObject({
      detail: "Agent is already processing another prompt.",
    });
  });

  it("clears the active Pi turn when prompt throws synchronously", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(() => {
      throw new Error("Synchronous prompt failure.");
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-sync-prompt-throw");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const send = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "new work",
            attachments: [],
            interactionMode: "default",
          }),
        );
        const session = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );
        return { send, session };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.send._tag).toBe("Failure");
    expect(result.session).toMatchObject({
      status: "ready",
      lastError: "Synchronous prompt failure.",
    });
    expect(result.session).not.toHaveProperty("activeTurnId");
  });

  it("does not complete from prompt resolution while the Pi SDK still reports streaming", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async (_text, options) => {
      options?.preflightResult?.(true);
      for (const listener of fake.session.subscribe.mock.calls.map(
        (call) => call[0] as (event: FakePiEvent) => void,
      )) {
        listener({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            delta: "Still working...",
          },
        });
      }
      (fake.session as typeof fake.session & { isStreaming: boolean }).isStreaming = true;
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-resolved-while-streaming");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "keep working",
          attachments: [],
          interactionMode: "default",
        });
        yield* Effect.sleep("10 millis");
        const session = (yield* adapter.listSessions()).find(
          (candidate) => candidate.threadId === threadId,
        );
        yield* adapter.stopSession(threadId);
        return { session, turn };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.session).toMatchObject({
      status: "running",
      activeTurnId: result.turn.turnId,
    });
  });

  it("discovers Pi native commands and skills", async () => {
    const fake = createFakePiRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const capabilities = yield* adapter.getComposerCapabilities!();
        const skills = yield* adapter.listSkills!({
          provider: "pi",
          cwd: process.cwd(),
        });
        const commandsBeforeSession = yield* adapter.listCommands!({
          provider: "pi",
          cwd: process.cwd(),
        });
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-discovery"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const commandsFromSession = yield* adapter.listCommands!({
          provider: "pi",
          cwd: process.cwd(),
          threadId: "thread-pi-discovery",
          forceReload: true,
        });
        return { capabilities, commandsBeforeSession, commandsFromSession, skills };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.capabilities).toMatchObject({
      provider: "pi",
      supportsSkillMentions: true,
      supportsSkillDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
    });
    expect(result.skills).toMatchObject({
      source: "pi-sdk",
      cached: false,
      skills: [
        {
          name: "review-code",
          path: "/tmp/pi-skills/review-code/SKILL.md",
          enabled: true,
          scope: "project",
          interface: {
            displayName: "review-code",
            shortDescription: "Review code carefully",
          },
        },
      ],
    });
    expect(result.commandsBeforeSession.commands).toEqual([
      { name: "release", description: "Prepare a release" },
      { name: "summarize", description: "Summarize the current thread" },
    ]);
    expect(result.commandsFromSession.commands).toEqual([
      { name: "release", description: "Prepare a release" },
      { name: "summarize", description: "Summarize the current thread" },
    ]);
    expect(fake.session.resourceLoader.reload).toHaveBeenCalled();
  });

  it("uses the requested cwd for Pi discovery when no thread id is provided", async () => {
    const fake = createFakePiRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-discovery-cwd-a"),
          cwd: "/tmp/project-a",
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });

        vi.mocked(fake.runtime.createServices).mockClear();
        yield* adapter.listSkills!({
          provider: "pi",
          cwd: "/tmp/project-b",
        });
        yield* adapter.listCommands!({
          provider: "pi",
          cwd: "/tmp/project-b",
        });
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(fake.runtime.createServices).toHaveBeenCalledTimes(2);
    expect(fake.runtime.createServices).toHaveBeenNthCalledWith(1, { cwd: "/tmp/project-b" });
    expect(fake.runtime.createServices).toHaveBeenNthCalledWith(2, { cwd: "/tmp/project-b" });
  });

  it("keeps fabricated Pi tool update metadata stable through completion", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({
          type: "tool_execution_update",
          toolCallId: "late-tool",
          toolName: "grep",
          args: { pattern: "PiAdapter", path: "src" },
          partialResult: "searching",
        });
        listener({
          type: "tool_execution_end",
          toolCallId: "late-tool",
          toolName: "grep",
          result: "done",
          isError: false,
        });
        listener({ type: "agent_end" });
      }
    });

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-fabricated-tool"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-fabricated-tool"),
          input: "search",
          attachments: [],
          interactionMode: "default",
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    const toolUpdated = collected.find((event) => event.type === "item.updated");
    const toolCompleted = collected.find((event) => event.type === "item.completed");
    expect(toolUpdated?.createdAt).toBeDefined();
    expect(toolCompleted?.createdAt).toBe(toolUpdated?.createdAt);
  });

  it("does not duplicate Pi grep glob values in tool titles", async () => {
    const fake = createFakePiRuntime();
    fake.session.prompt.mockImplementation(async () => {
      const listeners = new Set(
        fake.session.subscribe.mock.calls.map((call) => call[0] as (event: FakePiEvent) => void),
      );
      for (const listener of listeners) {
        listener({ type: "agent_start" });
        listener({
          type: "tool_execution_start",
          toolCallId: "grep-glob",
          toolName: "grep",
          args: { glob: "**/*.ts" },
        });
        listener({ type: "agent_end" });
      }
    });

    const collected = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi-grep-glob-title"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-pi-grep-glob-title"),
          input: "search",
          attachments: [],
          interactionMode: "default",
        });
        return Array.from(yield* Fiber.join(eventsFiber));
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(collected.find((event) => event.type === "item.started")).toMatchObject({
      payload: {
        title: "Search files matching **/*.ts",
      },
    });
  });

  it("interrupts, stops, lists models, rejects pending requests, and reads thread snapshots", async () => {
    const fake = createFakePiRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        yield* adapter.startSession({
          provider: "pi",
          threadId: asThreadId("thread-pi"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5",
          },
        });
        const models = yield* adapter.listModels!({ provider: "pi" });
        const snapshot = yield* adapter.readThread(asThreadId("thread-pi"));
        const respondToRequest = yield* Effect.exit(
          adapter.respondToRequest(
            asThreadId("thread-pi"),
            ApprovalRequestId.makeUnsafe("request-1"),
            "accept",
          ),
        );
        yield* adapter.interruptTurn(asThreadId("thread-pi"));
        yield* adapter.stopSession(asThreadId("thread-pi"));
        const hasSession = yield* adapter.hasSession(asThreadId("thread-pi"));
        return { hasSession, models, respondToRequest, snapshot };
      }).pipe(Effect.provide(providePiAdapter(fake.runtime))),
    );

    expect(result.models?.source).toBe("pi-sdk");
    expect(result.models?.models[0]).toMatchObject({
      slug: "anthropic/claude-sonnet-pi",
      upstreamProviderId: "anthropic",
    });
    expect(result.models?.models[1]).toMatchObject({
      slug: "openai/gpt-5",
      defaultReasoningEffort: "medium",
    });
    expect(result.snapshot.turns).toHaveLength(1);
    expect(result.respondToRequest._tag).toBe("Failure");
    expect(fake.session.abort).toHaveBeenCalled();
    expect(fake.session.dispose).toHaveBeenCalled();
    expect(fake.unsubscribe).toHaveBeenCalled();
    expect(result.hasSession).toBe(false);
  });
});
