import { describe, expect, it } from "vitest";

import { resolveDesktopWindowChrome, resolveDesktopWindowState } from "./windowChrome";

describe("resolveDesktopWindowChrome", () => {
  it("keeps native inset traffic lights on macOS", () => {
    expect(resolveDesktopWindowChrome("darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: "under-window",
      visualEffectState: "active",
    });
  });

  it("switches Windows and Linux to a hidden custom title bar", () => {
    expect(resolveDesktopWindowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
    });
    expect(resolveDesktopWindowChrome("linux")).toEqual({
      titleBarStyle: "hidden",
    });
  });
});

describe("resolveDesktopWindowState", () => {
  it("treats maximized windows as maximized", () => {
    expect(
      resolveDesktopWindowState({
        isMaximized: () => true,
        isFullScreen: () => false,
      }),
    ).toEqual({
      isMaximized: true,
    });
  });

  it("treats fullscreen windows as maximized for renderer chrome", () => {
    expect(
      resolveDesktopWindowState({
        isMaximized: () => false,
        isFullScreen: () => true,
      }),
    ).toEqual({
      isMaximized: true,
    });
  });
});
