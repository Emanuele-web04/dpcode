import { EventId, type ModelSelection, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  buildThreadHandoffImportedActivities,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffModelSelection,
} from "./threadHandoff";
import { type Thread } from "../types";

function makeActivity(id: string, kind: string, payload: unknown): Thread["activities"][number] {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-04-28T00:00:00.000Z",
  };
}

describe("threadHandoff", () => {
  it("lists all supported handoff targets except the active provider", () => {
    expect(resolveAvailableHandoffTargetProviders("codex")).toEqual([
      "claudeAgent",
      "gemini",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("claudeAgent")).toEqual([
      "codex",
      "gemini",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("gemini")).toEqual([
      "codex",
      "claudeAgent",
      "opencode",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("opencode")).toEqual([
      "codex",
      "claudeAgent",
      "gemini",
      "pi",
    ]);
    expect(resolveAvailableHandoffTargetProviders("pi")).toEqual([
      "codex",
      "claudeAgent",
      "gemini",
      "opencode",
    ]);
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "gemini",
      model: "gemini-2.5-pro",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "gemini",
        projectDefaultModelSelection: {
          provider: "gemini",
          model: "gemini-3.1-pro-preview",
        },
        stickyModelSelectionByProvider: {
          gemini: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "gemini",
            model: "gemini-2.5-pro",
          },
        },
        targetProvider: "codex",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });

  it("uses sticky Pi model selections for Pi handoff targets", () => {
    const stickySelection = {
      provider: "pi",
      model: "anthropic/claude-sonnet-pi",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
          },
        },
        targetProvider: "pi",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {
          pi: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the Pi provider default for Pi handoff targets", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "codex",
            model: "gpt-5.5",
          },
        },
        targetProvider: "pi",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "pi",
      model: "openai/gpt-5",
    });
  });

  it("does not import source-provider context telemetry into a different target provider", () => {
    const importedActivities = buildThreadHandoffImportedActivities(
      {
        modelSelection: {
          provider: "pi",
          model: "anthropic/claude-sonnet",
        },
        activities: [
          makeActivity("activity-pi-context-configured", "context-window.configured", {
            maxTokens: 200_000,
          }),
          makeActivity("activity-pi-context-updated", "context-window.updated", {
            usedTokens: 42_000,
            maxTokens: 200_000,
          }),
          makeActivity("activity-pi-rate-limit", "account.rate-limits.updated", {
            primary: {
              label: "Pi",
            },
          }),
        ],
      },
      "codex",
    );

    expect(importedActivities).toEqual([]);
  });
});
