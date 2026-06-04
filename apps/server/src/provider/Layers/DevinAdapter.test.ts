import { describe, it, assert } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { ThreadId } from "@t3tools/contracts";

import { DevinAdapter } from "../Services/DevinAdapter";
import { buildDevinPromptArgs, makeDevinAdapterLive } from "./DevinAdapter";

const threadId = ThreadId.makeUnsafe("thread-devin");

describe("buildDevinPromptArgs", () => {
  it("builds default print-mode argv without a model", () => {
    assert.deepStrictEqual(buildDevinPromptArgs({ prompt: "fix this" }), ["-p", "--", "fix this"]);
  });

  it("builds print-mode argv with a model", () => {
    assert.deepStrictEqual(buildDevinPromptArgs({ prompt: "fix this", model: "sonnet" }), [
      "--model",
      "sonnet",
      "-p",
      "--",
      "fix this",
    ]);
  });

  it("protects prompts that look like flags", () => {
    assert.deepStrictEqual(buildDevinPromptArgs({ prompt: "--help" }), ["-p", "--", "--help"]);
  });
});

describe("DevinAdapterLive", () => {
  it.effect("starts a Devin provider session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.strictEqual(adapter.provider, "devin");
      assert.strictEqual(session.provider, "devin");
      assert.strictEqual(session.status, "ready");
      assert.strictEqual(session.cwd, "/tmp/project");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          runCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
        }),
      ),
    ),
  );

  it.effect("sends prompts through direct devin print-mode argv", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "refactor this module",
      });

      assert.strictEqual(result.threadId, threadId);
      assert.deepStrictEqual(calls, [
        {
          command: "devin",
          args: ["-p", "--", "refactor this module"],
          cwd: "/tmp/project",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          runCommand: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { stdout: "done", stderr: "", code: 0 };
            }),
        }),
      ),
    );
  });

  it.effect("adds the Devin model flag when model selection is provided", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "refactor this module",
        modelSelection: {
          provider: "devin",
          model: "opus",
        },
      });

      assert.deepStrictEqual(calls[0]?.args, [
        "--model",
        "opus",
        "-p",
        "--",
        "refactor this module",
      ]);
      assert.notStrictEqual(calls[0]?.args[0], "opencode");
      assert.notStrictEqual(calls[0]?.args[0], "claude");
      assert.notStrictEqual(calls[0]?.args[0], "codex");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          runCommand: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { stdout: "done", stderr: "", code: 0 };
            }),
        }),
      ),
    );
  });

  it.effect("fails the turn when Devin exits nonzero", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "refactor this module",
        }),
      );

      assert.strictEqual(Exit.isFailure(exit), true);
      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions[0]?.status, "error");
      assert.strictEqual(sessions[0]?.lastError, "Devin auth failed");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          runCommand: () =>
            Effect.succeed({
              stdout: "",
              stderr: "Devin auth failed",
              code: 1,
            }),
        }),
      ),
    ),
  );
});
