import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import type { DesktopWindowState } from "@t3tools/contracts";

export function resolveDesktopWindowChrome(
  platform: NodeJS.Platform,
): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "vibrancy" | "visualEffectState"
> {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: "under-window",
      visualEffectState: "active",
    };
  }

  return {
    titleBarStyle: "hidden",
  };
}

export function resolveDesktopWindowState(
  window: Pick<BrowserWindow, "isMaximized" | "isFullScreen">,
): DesktopWindowState {
  return {
    isMaximized: window.isMaximized() || window.isFullScreen(),
  };
}
