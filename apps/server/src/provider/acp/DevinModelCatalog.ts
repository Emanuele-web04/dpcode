/**
 * DevinModelCatalog - Devin model fallback data.
 *
 * PROVENANCE: This is a snapshot of the models advertised by `devin acp`
 * (Devin CLI) as of 2026-06. It is FALLBACK DATA ONLY — the authoritative
 * model list comes from the live ACP session's "model" config option
 * (see listModels in Layers/DevinAdapter.ts). Update this snapshot only when
 * Devin's defaults change; never let UI or tests treat it as runtime truth.
 *
 * @module DevinModelCatalog
 */
import { MODEL_OPTIONS_BY_PROVIDER, MODEL_SLUG_ALIASES_BY_PROVIDER } from "@t3tools/contracts";

export const DEVIN_FALLBACK_MODELS = MODEL_OPTIONS_BY_PROVIDER.devin.map((option) => ({
  slug: option.slug,
  name: option.name,
}));

export function normalizeDevinModelSlug(model: string): string {
  const trimmed = model.trim();
  return MODEL_SLUG_ALIASES_BY_PROVIDER.devin[trimmed.toLowerCase()] ?? trimmed;
}
