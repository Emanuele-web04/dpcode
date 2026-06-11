import { describe, it, assert } from "@effect/vitest";
import { MODEL_OPTIONS_BY_PROVIDER } from "@t3tools/contracts";
import { DEVIN_FALLBACK_MODELS, normalizeDevinModelSlug } from "./DevinModelCatalog.ts";

describe("normalizeDevinModelSlug", () => {
  it('maps "opus" to "claude-opus-4-8-medium"', () => {
    assert.strictEqual(normalizeDevinModelSlug("opus"), "claude-opus-4-8-medium");
  });

  it('trims whitespace and lowercases input (e.g. " SWE " → "swe-1-6")', () => {
    assert.strictEqual(normalizeDevinModelSlug(" SWE "), "swe-1-6");
  });

  it("passes through unknown slugs unchanged", () => {
    assert.strictEqual(normalizeDevinModelSlug("claude-opus-4-8-medium"), "claude-opus-4-8-medium");
    assert.strictEqual(normalizeDevinModelSlug("unknown-model"), "unknown-model");
  });
});

describe("DEVIN_FALLBACK_MODELS", () => {
  it('contains "adaptive"', () => {
    const adaptive = DEVIN_FALLBACK_MODELS.find((m) => m.slug === "adaptive");
    assert.ok(adaptive, "expected adaptive model entry");
    assert.strictEqual(adaptive!.name, "Adaptive");
  });

  it("every entry has non-empty slug and name", () => {
    for (const model of DEVIN_FALLBACK_MODELS) {
      assert.ok(model.slug.length > 0, `expected non-empty slug, got "${model.slug}"`);
      assert.ok(model.name.length > 0, `expected non-empty name for "${model.slug}"`);
    }
  });

  it("slugs equal MODEL_OPTIONS_BY_PROVIDER.devin slugs (no duplication)", () => {
    const contractSlugs = MODEL_OPTIONS_BY_PROVIDER.devin.map((o) => o.slug);
    const catalogSlugs = DEVIN_FALLBACK_MODELS.map((m) => m.slug);
    assert.deepStrictEqual(catalogSlugs, contractSlugs);
  });
});
