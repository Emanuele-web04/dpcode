import type {
  ClaudeModelSelection,
  ClaudeModelOptions,
  CodexModelSelection,
  CodexModelOptions,
  GeminiModelSelection,
  GeminiModelOptions,
  ModelSelection,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import { formatModelDisplayName, normalizeModelSlug } from "@t3tools/shared/model";

export type ProviderOptions = ProviderModelOptions[ProviderKind];
export interface ProviderModelOption {
  slug: string;
  name: string;
  isCustom?: boolean;
}

function modelOptionKey(option: Pick<ProviderModelOption, "slug">): string {
  return option.slug.trim().toLowerCase();
}

export function mergeProviderModelOptions(
  preferred: ReadonlyArray<ProviderModelOption>,
  fallback: ReadonlyArray<ProviderModelOption>,
): ProviderModelOption[] {
  const merged = [...preferred];
  const seen = new Set(preferred.map((option) => modelOptionKey(option)));

  for (const option of fallback) {
    const key = modelOptionKey(option);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(option);
  }

  return merged;
}

/** Turn a raw model slug like "gpt-5.3-codex-spark" into "GPT-5.3 Codex Spark". */
function formatModelSlug(slug: string): string {
  return slug
    .replace(/^gpt-/i, "GPT-")
    .replace(/^claude-/i, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    const withoutContextSuffix = slug.replace(/\[[^\]]+\]$/u, "");
    return normalizeModelSlug(withoutContextSuffix, provider) ?? withoutContextSuffix;
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

export function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<ProviderModelOption>;
  dynamicModels: ReadonlyArray<{ slug: string; name?: string | null }>;
}): ReadonlyArray<ProviderModelOption> {
  const staticNameBySlug = new Map(input.staticOptions.map((model) => [model.slug, model.name]));
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: ProviderModelOption[] = [];

  for (const dynamicModel of input.dynamicModels) {
    const rawName = dynamicModel.name?.trim() ?? "";
    const isClaudeDefaultAlias =
      input.provider === "claudeAgent" &&
      (rawName.toLowerCase() === "default (recommended)" ||
        rawName.toLowerCase() === "default recommended" ||
        dynamicModel.slug.trim().toLowerCase() === "default");
    if (isClaudeDefaultAlias) {
      continue;
    }

    const normalizedSlug = normalizeDynamicModelSlug(input.provider, dynamicModel.slug);
    const rawSlug = dynamicModel.slug.trim().toLowerCase();
    const displayNameFallback =
      formatModelDisplayName(normalizedSlug) ?? formatModelSlug(normalizedSlug);
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        staticNameBySlug.get(normalizedSlug) ??
        (rawName.length > 0 &&
        rawName.toLowerCase() !== rawSlug &&
        rawName.toLowerCase() !== normalizedSlug.toLowerCase()
          ? rawName
          : displayNameFallback),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) => model.isCustom === true && !dynamicNormalizedSlugs.has(model.slug),
  );
  const staticBuiltInModels = input.staticOptions.filter((model) => model.isCustom !== true);
  const missingStaticBuiltIns = staticBuiltInModels.filter(
    (model) => !dynamicNormalizedSlugs.has(model.slug),
  );

  if (input.provider === "codex") {
    const dynamicBySlug = new Map(normalizedDynamicOptions.map((model) => [model.slug, model]));
    const staticBuiltInSlugs = new Set(staticBuiltInModels.map((model) => model.slug));
    const orderedStaticBuiltIns = staticBuiltInModels.map(
      (model) => dynamicBySlug.get(model.slug) ?? model,
    );
    const dynamicOnlyModels = normalizedDynamicOptions.filter(
      (model) => !staticBuiltInSlugs.has(model.slug),
    );
    return [...orderedStaticBuiltIns, ...dynamicOnlyModels, ...customOnlyModels];
  }

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}

export function buildNextProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  if (provider === "claudeAgent") {
    return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
  }
  return {
    ...(modelOptions as GeminiModelOptions | undefined),
    thinkingLevel: undefined,
    thinkingBudget: undefined,
    ...patch,
  } as GeminiModelOptions;
}

export function buildModelSelection(
  provider: "codex",
  model: string,
  options?: CodexModelOptions | null | undefined,
): CodexModelSelection;
export function buildModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ClaudeModelOptions | null | undefined,
): ClaudeModelSelection;
export function buildModelSelection(
  provider: "gemini",
  model: string,
  options?: GeminiModelOptions | null | undefined,
): GeminiModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection {
  switch (provider) {
    case "codex":
      return options
        ? {
            provider,
            model,
            options: options as CodexModelOptions,
          }
        : { provider, model };
    case "claudeAgent":
      return options
        ? {
            provider,
            model,
            options: options as ClaudeModelOptions,
          }
        : { provider, model };
    case "gemini":
      return options
        ? {
            provider,
            model,
            options: options as GeminiModelOptions,
          }
        : { provider, model };
  }
}
