import { describe, expect, it } from "vitest";

import { buildGeminiThinkingModelConfigAliases } from "./GeminiAdapter";

describe("buildGeminiThinkingModelConfigAliases", () => {
  it("creates the official Gemini 3 thinking levels and Gemini 2.5 budget presets", () => {
    const aliases = buildGeminiThinkingModelConfigAliases([
      "gemini-3-pro-preview",
      "gemini-2.5-pro",
    ]);

    expect(aliases["dpcode-gemini-gemini-3-pro-preview-thinking-level-high"]).toEqual({
      extends: "chat-base-3",
      modelConfig: {
        model: "gemini-3-pro-preview",
        generateContentConfig: {
          thinkingConfig: {
            thinkingLevel: "HIGH",
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-3-pro-preview-thinking-level-medium"]).toEqual({
      extends: "chat-base-3",
      modelConfig: {
        model: "gemini-3-pro-preview",
        generateContentConfig: {
          thinkingConfig: {
            thinkingLevel: "MEDIUM",
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-3-pro-preview-thinking-level-low"]).toEqual({
      extends: "chat-base-3",
      modelConfig: {
        model: "gemini-3-pro-preview",
        generateContentConfig: {
          thinkingConfig: {
            thinkingLevel: "LOW",
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-3-pro-preview-thinking-level-minimal"]).toEqual({
      extends: "chat-base-3",
      modelConfig: {
        model: "gemini-3-pro-preview",
        generateContentConfig: {
          thinkingConfig: {
            thinkingLevel: "MINIMAL",
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-2-5-pro-thinking-budget-8192"]).toEqual({
      extends: "chat-base-2.5",
      modelConfig: {
        model: "gemini-2.5-pro",
        generateContentConfig: {
          thinkingConfig: {
            thinkingBudget: 8192,
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-2-5-pro-thinking-budget-512"]).toEqual({
      extends: "chat-base-2.5",
      modelConfig: {
        model: "gemini-2.5-pro",
        generateContentConfig: {
          thinkingConfig: {
            thinkingBudget: 512,
          },
        },
      },
    });

    expect(aliases["dpcode-gemini-gemini-2-5-pro-thinking-budget-0"]).toEqual({
      extends: "chat-base-2.5",
      modelConfig: {
        model: "gemini-2.5-pro",
        generateContentConfig: {
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
      },
    });
  });
});
