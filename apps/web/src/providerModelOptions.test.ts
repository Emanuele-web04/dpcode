import { describe, expect, it } from "vitest";
import { mergeDynamicModelOptions } from "./providerModelOptions";

describe("mergeDynamicModelOptions", () => {
  it("keeps Codex built-in ordering ahead of runtime discovery ordering", () => {
    const merged = mergeDynamicModelOptions({
      provider: "codex",
      staticOptions: [
        { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false },
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false },
        { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini", isCustom: false },
      ],
      dynamicModels: [
        { slug: "gpt-5.4", name: "GPT-5.4" },
        { slug: "gpt-5.5", name: "GPT-5.5" },
        { slug: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
        { slug: "custom/runtime-codex", name: "Runtime Codex" },
      ],
    });

    expect(merged.map((model) => model.slug)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "custom/runtime-codex",
    ]);
  });

  it("preserves Claude runtime ordering behavior", () => {
    const merged = mergeDynamicModelOptions({
      provider: "claudeAgent",
      staticOptions: [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false }],
      dynamicModels: [
        { slug: "default", name: "Default (recommended)" },
        { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    });

    expect(merged.map((model) => model.slug)).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
  });
});
