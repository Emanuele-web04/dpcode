import { useEffect, useMemo } from "react";
import { useAppSettings } from "../appSettings";
import {
  buildThemeAppearanceCssVariables,
  getThemeAppearancePresetConfig,
  THEME_APPEARANCE_CSS_VARIABLE_KEYS,
  type ThemeAppearanceConfig,
} from "../themeAppearance";
import { useTheme } from "./useTheme";

function resolveThemeAppearanceConfig(input: {
  importedConfig: ThemeAppearanceConfig | null;
  selection:
    | "default"
    | "codex"
    | "github"
    | "linear"
    | "dracula"
    | "tokyo-night"
    | "vercel"
    | "imported";
  mode: "light" | "dark";
}): ThemeAppearanceConfig | null {
  if (input.selection === "default") {
    return null;
  }

  if (input.selection === "imported") {
    return input.importedConfig;
  }

  return getThemeAppearancePresetConfig(input.selection, input.mode);
}

export function useThemeAppearance() {
  const { settings } = useAppSettings();
  const { resolvedTheme } = useTheme();

  const activeConfig = useMemo(() => {
    if (resolvedTheme === "dark") {
      return resolveThemeAppearanceConfig({
        importedConfig: settings.darkImportedThemeAppearance,
        mode: "dark",
        selection: settings.darkThemeAppearance,
      });
    }

    return resolveThemeAppearanceConfig({
      importedConfig: settings.lightImportedThemeAppearance,
      mode: "light",
      selection: settings.lightThemeAppearance,
    });
  }, [
    resolvedTheme,
    settings.darkImportedThemeAppearance,
    settings.darkThemeAppearance,
    settings.lightImportedThemeAppearance,
    settings.lightThemeAppearance,
  ]);

  useEffect(() => {
    const root = document.documentElement;

    if (!activeConfig) {
      delete root.dataset.themeAppearance;
      delete root.dataset.themeWindows;
      for (const variableName of THEME_APPEARANCE_CSS_VARIABLE_KEYS) {
        root.style.removeProperty(variableName);
      }
      return;
    }

    const cssVariables = buildThemeAppearanceCssVariables(activeConfig, resolvedTheme);
    root.dataset.themeAppearance = "custom";
    root.dataset.themeWindows = activeConfig.opaqueWindows ? "opaque" : "translucent";
    for (const [variableName, value] of Object.entries(cssVariables)) {
      root.style.setProperty(variableName, value);
    }

    return () => {
      delete root.dataset.themeAppearance;
      delete root.dataset.themeWindows;
      for (const variableName of THEME_APPEARANCE_CSS_VARIABLE_KEYS) {
        root.style.removeProperty(variableName);
      }
    };
  }, [activeConfig, resolvedTheme]);
}
