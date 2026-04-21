import { describe, expect, it } from "vitest";

import { shouldUseCustomDesktopTitleBar } from "./desktopWindow";

describe("shouldUseCustomDesktopTitleBar", () => {
  it("stays on native chrome outside Electron", () => {
    expect(
      shouldUseCustomDesktopTitleBar({
        isElectron: false,
        platform: "Win32",
      }),
    ).toBe(false);
  });

  it("keeps macOS on the native traffic-light title bar", () => {
    expect(
      shouldUseCustomDesktopTitleBar({
        isElectron: true,
        platform: "MacIntel",
      }),
    ).toBe(false);
  });

  it("enables custom renderer chrome on Windows and Linux", () => {
    expect(
      shouldUseCustomDesktopTitleBar({
        isElectron: true,
        platform: "Win32",
      }),
    ).toBe(true);
    expect(
      shouldUseCustomDesktopTitleBar({
        isElectron: true,
        platform: "Linux x86_64",
      }),
    ).toBe(true);
  });
});
