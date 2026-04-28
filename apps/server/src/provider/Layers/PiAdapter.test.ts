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
    prompt: vi.fn(async () => {
      for (const listener of listeners) {
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
    }),
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

function providePiAdapter(runtime: FakePiRuntime) {
  return makePiAdapterLive({ runtime }).pipe(
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

  it("rejects plan mode and concurrent active turns", async () => {
    const fake = createFakePiRuntime();
    let releasePrompt: (() => void) | undefined;
    fake.session.prompt.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    );

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
