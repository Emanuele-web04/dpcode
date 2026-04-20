import type { DesktopBridge, DesktopWindowState } from "@t3tools/contracts";

import { isElectron } from "../env";
import { isMacPlatform } from "./utils";

export const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
  isMaximized: false,
};

export function shouldUseCustomDesktopTitleBar(input: {
  isElectron: boolean;
  platform: string;
}): boolean {
  return input.isElectron && !isMacPlatform(input.platform);
}

export function supportsCustomDesktopTitleBar(): boolean {
  return shouldUseCustomDesktopTitleBar({
    isElectron,
    platform: typeof navigator === "undefined" ? "" : navigator.platform ?? "",
  });
}

export function readDesktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge ?? null;
}
