import { describe, expect, it } from "vitest";

import {
  buildThemeAppearanceCssVariables,
  getThemeAppearancePresetConfig,
  getThemeAppearanceSelectionOptions,
  parseThemeAppearanceImport,
  resolveThemeAppearanceConfig,
} from "./themeAppearance";

describe("parseThemeAppearanceImport", () => {
  it("parses codex-theme-v1 payloads and preserves the imported values", () => {
    const parsed = parseThemeAppearanceImport(
      'codex-theme-v1:{"codeThemeId":"tokyo-night","theme":{"accent":"#3d59a1","contrast":50,"fonts":{"code":"\\"Geist Mono\\", ui-monospace, \\"SFMono-Regular\\"","ui":"Geist, Inter"},"ink":"#a9b1d6","opaqueWindows":true,"semanticColors":{"diffAdded":"#449dab","diffRemoved":"#914c54","skill":"#9d7cd8"},"surface":"#1a1b26"},"variant":"dark"}',
      "light",
    );

    expect(parsed.mode).toBe("dark");
    expect(parsed.sourceLabel).toBe("Tokyo Night");
    expect(parsed.config).toEqual({
      accent: "#3d59a1",
      contrast: 50,
      fonts: {
        code: '"Geist Mono", ui-monospace, "SFMono-Regular"',
        ui: "Geist, Inter",
      },
      ink: "#a9b1d6",
      opaqueWindows: true,
      semanticColors: {
        diffAdded: "#449dab",
        diffRemoved: "#914c54",
        skill: "#9d7cd8",
      },
      surface: "#1a1b26",
    });
  });

  it("uses the matching preset as fallback when the payload omits fields", () => {
    const parsed = parseThemeAppearanceImport(
      '{"codeThemeId":"dracula","theme":{"accent":"#ff79c6"},"variant":"dark"}',
      "dark",
    );

    expect(parsed.config.ink).toBe("#f8f8f2");
    expect(parsed.config.surface).toBe("#282a36");
    expect(parsed.config.semanticColors.skill).toBe("#bd93f9");
  });
});

describe("getThemeAppearanceSelectionOptions", () => {
  it("includes imported only when an imported theme exists for the mode", () => {
    expect(
      getThemeAppearanceSelectionOptions({ hasImportedTheme: false, mode: "dark" }).some(
        (option) => option.value === "imported",
      ),
    ).toBe(false);

    expect(
      getThemeAppearanceSelectionOptions({ hasImportedTheme: true, mode: "dark" }).some(
        (option) => option.value === "imported",
      ),
    ).toBe(true);
  });
});

describe("buildThemeAppearanceCssVariables", () => {
  it("derives CSS variables for preset-backed themes", () => {
    const dracula = getThemeAppearancePresetConfig("dracula", "dark");
    expect(dracula).not.toBeNull();

    const cssVariables = buildThemeAppearanceCssVariables(dracula!, "dark");

    expect(cssVariables["--background"]).toMatch(/^#[\da-f]{6}$/);
    expect(cssVariables["--link"]).toBe("#ff79c6");
    expect(cssVariables["--primary"]).toBe("#ff79c6");
    expect(cssVariables["--accent"]).not.toBe(cssVariables["--primary"]);
    expect(cssVariables["--sidebar-accent"]).not.toBe(cssVariables["--sidebar-primary"]);
    expect(cssVariables["--sidebar-border"]).toMatch(/^\d+ /);
  });

  it("keeps the codex dark preset aligned with the expected defaults", () => {
    expect(getThemeAppearancePresetConfig("codex", "dark")).toEqual({
      accent: "#0169cc",
      contrast: 46,
      fonts: {
        code: '"Jetbrains Mono"',
        ui: "Inter",
      },
      ink: "#fcfcfc",
      opaqueWindows: false,
      semanticColors: {
        diffAdded: "#00a240",
        diffRemoved: "#e02e2a",
        skill: "#b06dff",
      },
      surface: "#111111",
    });
  });
});

describe("resolveThemeAppearanceConfig", () => {
  it("falls back to the imported config when the selection is imported", () => {
    const config = resolveThemeAppearanceConfig({
      importedConfig: {
        accent: "#123456",
        contrast: 42,
        fonts: { code: "", ui: "" },
        ink: "#eeeeee",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#00ff00",
          diffRemoved: "#ff0000",
          skill: "#123456",
        },
        surface: "#101010",
      },
      mode: "dark",
      selection: "imported",
    });

    expect(config.accent).toBe("#123456");
    expect(config.opaqueWindows).toBe(false);
  });
});
