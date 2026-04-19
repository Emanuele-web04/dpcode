import { Schema } from "effect";

const HEX_COLOR_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;
const MIN_THEME_CONTRAST = 0;
const MAX_THEME_CONTRAST = 100;
const DEFAULT_THEME_CONTRAST = 50;
const MAX_FONT_FAMILY_LENGTH = 256;
const BLACK = "#000000";
const WHITE = "#ffffff";

export const ThemeAppearanceMode = Schema.Literals(["light", "dark"]);
export type ThemeAppearanceMode = typeof ThemeAppearanceMode.Type;

export const ThemeAppearanceSelectionId = Schema.Literals([
  "default",
  "codex",
  "github",
  "linear",
  "dracula",
  "tokyo-night",
  "vercel",
  "imported",
]);
export type ThemeAppearanceSelectionId = typeof ThemeAppearanceSelectionId.Type;
type ThemeAppearancePresetId = Exclude<ThemeAppearanceSelectionId, "default" | "imported">;

export const ThemeAppearanceFontsSchema = Schema.Struct({
  ui: Schema.String.check(Schema.isMaxLength(MAX_FONT_FAMILY_LENGTH)),
  code: Schema.String.check(Schema.isMaxLength(MAX_FONT_FAMILY_LENGTH)),
});
export type ThemeAppearanceFonts = typeof ThemeAppearanceFontsSchema.Type;

export const ThemeAppearanceSemanticColorsSchema = Schema.Struct({
  diffAdded: Schema.String,
  diffRemoved: Schema.String,
  skill: Schema.String,
});
export type ThemeAppearanceSemanticColors = typeof ThemeAppearanceSemanticColorsSchema.Type;

export const ThemeAppearanceConfigSchema = Schema.Struct({
  accent: Schema.String,
  contrast: Schema.Number,
  fonts: ThemeAppearanceFontsSchema,
  ink: Schema.String,
  opaqueWindows: Schema.Boolean,
  semanticColors: ThemeAppearanceSemanticColorsSchema,
  surface: Schema.String,
});
export type ThemeAppearanceConfig = typeof ThemeAppearanceConfigSchema.Type;

export type ParsedThemeAppearanceImport = {
  config: ThemeAppearanceConfig;
  mode: ThemeAppearanceMode;
  sourceLabel: string;
};

type ThemeAppearancePresetDefinition = {
  aliases?: readonly string[];
  configs: Partial<Record<ThemeAppearanceMode, ThemeAppearanceConfig>>;
  label: string;
};

type ThemeAppearanceConfigInput = {
  accent?: string | undefined;
  contrast?: number | undefined;
  fonts?:
    | {
        code?: string | undefined;
        ui?: string | undefined;
      }
    | undefined;
  ink?: string | undefined;
  opaqueWindows?: boolean | undefined;
  semanticColors?:
    | {
        diffAdded?: string | undefined;
        diffRemoved?: string | undefined;
        skill?: string | undefined;
      }
    | undefined;
  surface?: string | undefined;
};

const LIGHT_THEME_FALLBACK: ThemeAppearanceConfig = {
  accent: "#4f46e5",
  contrast: DEFAULT_THEME_CONTRAST,
  fonts: {
    code: "",
    ui: "",
  },
  ink: "#1f2937",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#15803d",
    diffRemoved: "#dc2626",
    skill: "#4f46e5",
  },
  surface: "#ffffff",
};

const DARK_THEME_FALLBACK: ThemeAppearanceConfig = {
  accent: "#3b82f6",
  contrast: DEFAULT_THEME_CONTRAST,
  fonts: {
    code: "",
    ui: "",
  },
  ink: "#f5f5f5",
  opaqueWindows: false,
  semanticColors: {
    diffAdded: "#22c55e",
    diffRemoved: "#ef4444",
    skill: "#3b82f6",
  },
  surface: "#161616",
};

const THEME_APPEARANCE_PRESETS = {
  codex: {
    label: "Codex",
    configs: {
      light: {
        accent: "#2563eb",
        contrast: 52,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#1f2937",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#16a34a",
          diffRemoved: "#dc2626",
          skill: "#2563eb",
        },
        surface: "#f8fafc",
      },
      dark: {
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
      },
    },
  },
  github: {
    aliases: ["github-dark", "github-light"],
    label: "GitHub",
    configs: {
      light: {
        accent: "#0969da",
        contrast: 46,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#1f2328",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#1a7f37",
          diffRemoved: "#cf222e",
          skill: "#0969da",
        },
        surface: "#ffffff",
      },
      dark: {
        accent: "#2f81f7",
        contrast: 50,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#e6edf3",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#3fb950",
          diffRemoved: "#f85149",
          skill: "#2f81f7",
        },
        surface: "#161b22",
      },
    },
  },
  linear: {
    label: "Linear",
    configs: {
      light: {
        accent: "#5e6ad2",
        contrast: 49,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#1b1b1b",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#1f9d55",
          diffRemoved: "#d14343",
          skill: "#5e6ad2",
        },
        surface: "#fcfcfd",
      },
      dark: {
        accent: "#5e6ad2",
        contrast: 49,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#f7f8f8",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#1f9d55",
          diffRemoved: "#d14343",
          skill: "#5e6ad2",
        },
        surface: "#1c1c1f",
      },
    },
  },
  dracula: {
    label: "Dracula",
    configs: {
      dark: {
        accent: "#ff79c6",
        contrast: 50,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#f8f8f2",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#50fa7b",
          diffRemoved: "#ff5555",
          skill: "#bd93f9",
        },
        surface: "#282a36",
      },
    },
  },
  "tokyo-night": {
    aliases: ["tokyonight"],
    label: "Tokyo Night",
    configs: {
      dark: {
        accent: "#3d59a1",
        contrast: 50,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#a9b1d6",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#449dab",
          diffRemoved: "#914c54",
          skill: "#9d7cd8",
        },
        surface: "#1a1b26",
      },
    },
  },
  vercel: {
    label: "Vercel",
    configs: {
      dark: {
        accent: "#ffffff",
        contrast: 56,
        fonts: {
          code: "",
          ui: "",
        },
        ink: "#f5f5f5",
        opaqueWindows: false,
        semanticColors: {
          diffAdded: "#2ea043",
          diffRemoved: "#f85149",
          skill: "#a78bfa",
        },
        surface: "#111111",
      },
    },
  },
} satisfies Record<ThemeAppearancePresetId, ThemeAppearancePresetDefinition>;
const THEME_APPEARANCE_PRESET_ENTRIES = Object.entries(THEME_APPEARANCE_PRESETS) as Array<
  [ThemeAppearancePresetId, ThemeAppearancePresetDefinition]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readStringProperty(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function readNumberProperty(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function expandHexColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 4) {
    const [, red, green, blue] = normalized;
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }
  return normalized;
}

function parseHexColor(value: string): { blue: number; green: number; red: number } {
  const expanded = expandHexColor(value);
  return {
    red: Number.parseInt(expanded.slice(1, 3), 16),
    green: Number.parseInt(expanded.slice(3, 5), 16),
    blue: Number.parseInt(expanded.slice(5, 7), 16),
  };
}

function toHexColor(rgb: { blue: number; green: number; red: number }): string {
  return `#${[rgb.red, rgb.green, rgb.blue]
    .map((channel) => clampByte(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixHexColors(from: string, to: string, ratio: number): string {
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const source = parseHexColor(from);
  const target = parseHexColor(to);

  return toHexColor({
    red: source.red + (target.red - source.red) * clampedRatio,
    green: source.green + (target.green - source.green) * clampedRatio,
    blue: source.blue + (target.blue - source.blue) * clampedRatio,
  });
}

function normalizeThemeHexColor(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || !HEX_COLOR_PATTERN.test(normalized)) {
    return fallback;
  }

  return expandHexColor(normalized);
}

export function normalizeThemeFontFamily(value: string | null | undefined, fallback = ""): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }

  return normalized.slice(0, MAX_FONT_FAMILY_LENGTH);
}

export function normalizeThemeContrast(value: number | null | undefined, fallback = 50): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_THEME_CONTRAST, Math.max(MIN_THEME_CONTRAST, Math.round(value)));
}

function normalizeThemeAppearanceConfig(
  config: ThemeAppearanceConfigInput | null | undefined,
  fallback: ThemeAppearanceConfig,
): ThemeAppearanceConfig {
  return {
    accent: normalizeThemeHexColor(config?.accent, fallback.accent),
    contrast: normalizeThemeContrast(config?.contrast, fallback.contrast),
    fonts: {
      ui: normalizeThemeFontFamily(config?.fonts?.ui, fallback.fonts.ui),
      code: normalizeThemeFontFamily(config?.fonts?.code, fallback.fonts.code),
    },
    ink: normalizeThemeHexColor(config?.ink, fallback.ink),
    opaqueWindows:
      typeof config?.opaqueWindows === "boolean" ? config.opaqueWindows : fallback.opaqueWindows,
    semanticColors: {
      diffAdded: normalizeThemeHexColor(
        config?.semanticColors?.diffAdded,
        fallback.semanticColors.diffAdded,
      ),
      diffRemoved: normalizeThemeHexColor(
        config?.semanticColors?.diffRemoved,
        fallback.semanticColors.diffRemoved,
      ),
      skill: normalizeThemeHexColor(config?.semanticColors?.skill, fallback.semanticColors.skill),
    },
    surface: normalizeThemeHexColor(config?.surface, fallback.surface),
  };
}

function fallbackThemeAppearanceForMode(mode: ThemeAppearanceMode): ThemeAppearanceConfig {
  return mode === "dark" ? DARK_THEME_FALLBACK : LIGHT_THEME_FALLBACK;
}

function rgbToHslString(value: string): string {
  const { red, green, blue } = parseHexColor(value);
  const redUnit = red / 255;
  const greenUnit = green / 255;
  const blueUnit = blue / 255;
  const max = Math.max(redUnit, greenUnit, blueUnit);
  const min = Math.min(redUnit, greenUnit, blueUnit);
  const lightness = (max + min) / 2;
  const delta = max - min;

  let hue = 0;
  let saturation = 0;

  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));

    switch (max) {
      case redUnit: {
        hue = ((greenUnit - blueUnit) / delta) % 6;
        break;
      }
      case greenUnit: {
        hue = (blueUnit - redUnit) / delta + 2;
        break;
      }
      default: {
        hue = (redUnit - greenUnit) / delta + 4;
        break;
      }
    }
  }

  const normalizedHue = Math.round((hue * 60 + 360) % 360);
  const normalizedSaturation = Math.round(saturation * 1000) / 10;
  const normalizedLightness = Math.round(lightness * 1000) / 10;
  return `${normalizedHue} ${normalizedSaturation}% ${normalizedLightness}%`;
}

function relativeLuminance(value: string): number {
  const { red, green, blue } = parseHexColor(value);
  const normalizeChannel = (channel: number) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const r = normalizeChannel(red);
  const g = normalizeChannel(green);
  const b = normalizeChannel(blue);

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableForegroundColor(
  background: string,
  preferredLight: string,
  preferredDark: string,
) {
  return relativeLuminance(background) > 0.45 ? preferredDark : preferredLight;
}

function deriveThemeBackground(config: ThemeAppearanceConfig, mode: ThemeAppearanceMode): string {
  const contrastFactor = config.contrast / 100;
  if (mode === "dark") {
    return mixHexColors(config.surface, BLACK, 0.12 + contrastFactor * 0.22);
  }

  return mixHexColors(config.surface, WHITE, 0.1 + contrastFactor * 0.2);
}

export function buildThemeAppearanceCssVariables(
  config: ThemeAppearanceConfig,
  mode: ThemeAppearanceMode,
): Record<string, string> {
  const contrastFactor = config.contrast / 100;
  const background = deriveThemeBackground(config, mode);
  const card = config.surface;
  const popover =
    mode === "dark"
      ? mixHexColors(card, BLACK, 0.04 + contrastFactor * 0.08)
      : mixHexColors(card, WHITE, 0.02 + contrastFactor * 0.06);
  const secondary =
    mode === "dark"
      ? mixHexColors(card, config.ink, 0.04 + contrastFactor * 0.04)
      : mixHexColors(card, config.ink, 0.03 + contrastFactor * 0.03);
  const muted =
    mode === "dark"
      ? mixHexColors(card, config.ink, 0.06 + contrastFactor * 0.05)
      : mixHexColors(card, config.ink, 0.04 + contrastFactor * 0.05);
  const neutralAccentSurface =
    mode === "dark"
      ? mixHexColors(card, WHITE, 0.08 + contrastFactor * 0.04)
      : mixHexColors(card, BLACK, 0.035 + contrastFactor * 0.025);
  const border =
    mode === "dark"
      ? mixHexColors(card, config.ink, 0.1 + contrastFactor * 0.08)
      : mixHexColors(card, config.ink, 0.08 + contrastFactor * 0.08);
  const input =
    mode === "dark"
      ? mixHexColors(card, config.ink, 0.07 + contrastFactor * 0.06)
      : mixHexColors(card, config.ink, 0.06 + contrastFactor * 0.06);
  const mutedForeground =
    mode === "dark"
      ? mixHexColors(config.ink, background, 0.32)
      : mixHexColors(config.ink, background, 0.38);
  const primaryForeground = readableForegroundColor(config.accent, WHITE, "#111111");
  const successForeground = readableForegroundColor(
    config.semanticColors.diffAdded,
    WHITE,
    "#111111",
  );
  const destructiveForeground = readableForegroundColor(
    config.semanticColors.diffRemoved,
    WHITE,
    "#111111",
  );
  const sidebarSurface = config.opaqueWindows
    ? mixHexColors(card, background, 0.12)
    : mixHexColors(card, background, 0.04);

  return {
    "--accent": neutralAccentSurface,
    "--accent-foreground": config.ink,
    "--background": background,
    "--border": border,
    "--card": card,
    "--card-foreground": config.ink,
    "--claude": config.semanticColors.skill,
    "--destructive": config.semanticColors.diffRemoved,
    "--destructive-foreground": destructiveForeground,
    "--foreground": config.ink,
    "--info": config.semanticColors.skill,
    "--info-foreground": config.semanticColors.skill,
    "--input": input,
    "--link": config.accent,
    "--muted": muted,
    "--muted-foreground": mutedForeground,
    "--popover": popover,
    "--popover-foreground": config.ink,
    "--primary": config.accent,
    "--primary-foreground": primaryForeground,
    "--ring": config.accent,
    "--secondary": secondary,
    "--secondary-foreground": config.ink,
    "--sidebar": rgbToHslString(sidebarSurface),
    "--sidebar-accent": rgbToHslString(neutralAccentSurface),
    "--sidebar-accent-foreground": rgbToHslString(config.ink),
    "--sidebar-border": rgbToHslString(border),
    "--sidebar-foreground": rgbToHslString(config.ink),
    "--sidebar-primary": rgbToHslString(config.accent),
    "--sidebar-primary-foreground": rgbToHslString(primaryForeground),
    "--sidebar-ring": rgbToHslString(config.accent),
    "--success": config.semanticColors.diffAdded,
    "--success-foreground": successForeground,
  };
}

export const THEME_APPEARANCE_CSS_VARIABLE_KEYS = [
  "--accent",
  "--accent-foreground",
  "--background",
  "--border",
  "--card",
  "--card-foreground",
  "--claude",
  "--destructive",
  "--destructive-foreground",
  "--foreground",
  "--info",
  "--info-foreground",
  "--input",
  "--link",
  "--muted",
  "--muted-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--secondary",
  "--secondary-foreground",
  "--sidebar",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-border",
  "--sidebar-foreground",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
  "--success",
  "--success-foreground",
] as const;

export function getThemeAppearanceSelectionOptions(input: {
  hasImportedTheme: boolean;
  mode: ThemeAppearanceMode;
}): ReadonlyArray<{ label: string; value: ThemeAppearanceSelectionId }> {
  const options: Array<{ label: string; value: ThemeAppearanceSelectionId }> = [
    { label: "Default", value: "default" as const },
    ...THEME_APPEARANCE_PRESET_ENTRIES.filter(([, preset]) => preset.configs[input.mode]).map(
      ([id, preset]) => ({
        label: preset.label,
        value: id,
      }),
    ),
  ];

  if (input.hasImportedTheme) {
    options.push({
      label: "Imported",
      value: "imported",
    });
  }

  return options;
}

export function getThemeAppearancePresetConfig(
  id: ThemeAppearanceSelectionId,
  mode: ThemeAppearanceMode,
): ThemeAppearanceConfig | null {
  if (id === "default" || id === "imported") {
    return null;
  }

  const preset = THEME_APPEARANCE_PRESETS[id] as ThemeAppearancePresetDefinition | undefined;
  const config = preset?.configs[mode];
  return config
    ? normalizeThemeAppearanceConfig(config, fallbackThemeAppearanceForMode(mode))
    : null;
}

export function resolveThemeAppearanceConfig(input: {
  importedConfig: ThemeAppearanceConfig | null | undefined;
  mode: ThemeAppearanceMode;
  selection: ThemeAppearanceSelectionId;
}): ThemeAppearanceConfig {
  const fallback = fallbackThemeAppearanceForMode(input.mode);

  if (input.selection === "imported") {
    return normalizeThemeAppearanceConfig(input.importedConfig, fallback);
  }

  return getThemeAppearancePresetConfig(input.selection, input.mode) ?? fallback;
}

function resolveThemeAppearancePresetId(value: string | undefined): ThemeAppearancePresetId | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const [id, preset] of THEME_APPEARANCE_PRESET_ENTRIES) {
    if (normalized === id || preset.aliases?.includes(normalized)) {
      return id;
    }
  }

  return null;
}

export function parseThemeAppearanceImport(
  input: string,
  targetMode: ThemeAppearanceMode,
): ParsedThemeAppearanceImport {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Paste a theme JSON to import.");
  }

  const jsonPayload = trimmed.startsWith("codex-theme-v1:") ? trimmed.slice(15) : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch {
    throw new Error("Theme import must be valid JSON.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Theme import must be a JSON object.");
  }

  const codeThemeId = readStringProperty(parsed, "codeThemeId");
  const presetId = resolveThemeAppearancePresetId(codeThemeId);
  const variant = readStringProperty(parsed, "variant");
  const mode = variant === "light" || variant === "dark" ? variant : targetMode;
  const themeRecord = isRecord(parsed.theme) ? parsed.theme : null;
  if (!themeRecord) {
    throw new Error("Theme import must include a `theme` object.");
  }
  if (
    !(
      "accent" in themeRecord ||
      "contrast" in themeRecord ||
      "fonts" in themeRecord ||
      "ink" in themeRecord ||
      "opaqueWindows" in themeRecord ||
      "semanticColors" in themeRecord ||
      "surface" in themeRecord
    )
  ) {
    throw new Error("Theme import is missing the supported theme fields.");
  }
  const fallback = (() => {
    return presetId
      ? (getThemeAppearancePresetConfig(presetId, mode) ?? fallbackThemeAppearanceForMode(mode))
      : fallbackThemeAppearanceForMode(mode);
  })();
  const fontsRecord = isRecord(themeRecord.fonts) ? themeRecord.fonts : {};
  const semanticColorsRecord = isRecord(themeRecord.semanticColors)
    ? themeRecord.semanticColors
    : {};
  const config = normalizeThemeAppearanceConfig(
    {
      accent: readStringProperty(themeRecord, "accent"),
      contrast: readNumberProperty(themeRecord, "contrast"),
      fonts: {
        ui: readStringProperty(fontsRecord, "ui"),
        code: readStringProperty(fontsRecord, "code"),
      },
      ink: readStringProperty(themeRecord, "ink"),
      opaqueWindows:
        typeof themeRecord.opaqueWindows === "boolean" ? themeRecord.opaqueWindows : undefined,
      semanticColors: {
        diffAdded: readStringProperty(semanticColorsRecord, "diffAdded"),
        diffRemoved: readStringProperty(semanticColorsRecord, "diffRemoved"),
        skill: readStringProperty(semanticColorsRecord, "skill"),
      },
      surface: readStringProperty(themeRecord, "surface"),
    },
    fallback,
  );

  return {
    config,
    mode,
    sourceLabel:
      presetId && codeThemeId ? THEME_APPEARANCE_PRESETS[presetId].label : "Imported theme",
  };
}
