import "../../index.css";

import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { renderProviderTraitsPicker } from "./composerProviderRegistry";

const GEMINI_THREAD_ID = ThreadId.makeUnsafe("thread-gemini-registry-picker");

async function mountGeminiTraitsPicker(props?: { open?: boolean }) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <>
      {renderProviderTraitsPicker({
        provider: "gemini",
        threadId: GEMINI_THREAD_ID,
        model: "gemini-2.5-pro",
        modelOptions: undefined,
        prompt: "",
        ...(props?.open !== undefined ? { open: props.open } : {}),
        onPromptChange: () => {},
      })}
    </>,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("renderProviderTraitsPicker (Gemini browser)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the Gemini traits menu when the shared composer state requests it", async () => {
    await using _ = await mountGeminiTraitsPicker({ open: true });

    await vi.waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toContain("Effort");
      expect(text).toContain("Dynamic");
      expect(text).toContain("512 Tokens");
    });
  });
});
