// FILE: diffRendering.test.ts
// Purpose: Verifies shared git patch helpers used by diff chrome and header badges.
// Layer: Web diff utility tests
// Depends on: Vitest and diffRendering helpers

import { describe, expect, it } from "vitest";
import {
  buildPatchCacheKey,
  getRenderablePatch,
  resolveDiffCopyText,
  serializeRenderablePatchText,
  summarizePatchStats,
} from "./diffRendering";

describe("buildPatchCacheKey", () => {
  it("returns a stable cache key for identical content", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch));
  });

  it("normalizes outer whitespace before hashing", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(`\n${patch}\n`)).toBe(buildPatchCacheKey(patch));
  });

  it("changes when diff content changes", () => {
    const before = "diff --git a/a.ts b/a.ts\n+console.log('hello')";
    const after = "diff --git a/a.ts b/a.ts\n+console.log('hello world')";

    expect(buildPatchCacheKey(before)).not.toBe(buildPatchCacheKey(after));
  });

  it("changes when cache scope changes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')";

    expect(buildPatchCacheKey(patch, "diff-panel:light")).not.toBe(
      buildPatchCacheKey(patch, "diff-panel:dark"),
    );
  });
});

describe("resolveDiffCopyText", () => {
  it("preserves the original patch content for clipboard writes", () => {
    const patch = "diff --git a/a.ts b/a.ts\n+console.log('hello')\n";

    expect(resolveDiffCopyText(patch)).toBe(patch);
  });

  it("does not expose empty or missing patches as copyable", () => {
    expect(resolveDiffCopyText(undefined)).toBeNull();
    expect(resolveDiffCopyText(" \n\t ")).toBeNull();
  });
});

describe("serializeRenderablePatchText", () => {
  it("returns every line for a large diff that would be virtualized in the DOM", () => {
    const LINE_COUNT = 6000;
    const bodyLines = Array.from(
      { length: LINE_COUNT },
      (_, index) => `+line ${String(index + 1).padStart(4, "0")}`,
    );
    const patch = [
      "diff --git a/big.txt b/big.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/big.txt",
      `@@ -0,0 +1,${LINE_COUNT} @@`,
      ...bodyLines,
      "",
    ].join("\n");

    const renderable = getRenderablePatch(patch, "diff-panel:test");
    expect(renderable?.kind).toBe("files");

    const serialized = serializeRenderablePatchText(renderable);
    expect(serialized).not.toBeNull();

    const serializedAdditions = serialized!.split("\n").filter((line) => line.startsWith("+line "));
    expect(serializedAdditions).toHaveLength(LINE_COUNT);
    expect(serializedAdditions[0]).toBe("+line 0001");
    expect(serializedAdditions[2999]).toBe("+line 3000");
    expect(serializedAdditions.at(-1)).toBe(`+line ${String(LINE_COUNT).padStart(4, "0")}`);
    for (const expected of bodyLines) {
      expect(serialized).toContain(expected);
    }
    // The serializer must not inject blank lines between diff rows.
    expect(serialized).not.toContain("\n\n");
  });

  it("reconstructs context and change lines in order for a mixed patch", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,4 @@",
      " const stable = true;",
      "-const oldValue = 1;",
      "+const newValue = 1;",
      "+const addedValue = 2;",
      " export { stable };",
      "",
    ].join("\n");

    const serialized = serializeRenderablePatchText(getRenderablePatch(patch, "diff-panel:test"));

    expect(serialized).not.toBeNull();
    const serializedLines = serialized!.split("\n");
    expect(serializedLines).toContain(" const stable = true;");
    expect(serializedLines).toContain("-const oldValue = 1;");
    expect(serializedLines).toContain("+const newValue = 1;");
    expect(serializedLines).toContain("+const addedValue = 2;");
    expect(serializedLines).toContain(" export { stable };");
    // Deletions are emitted before additions within a change block.
    expect(serializedLines.indexOf("-const oldValue = 1;")).toBeLessThan(
      serializedLines.indexOf("+const newValue = 1;"),
    );
  });

  it("passes raw patches through untouched", () => {
    const serialized = serializeRenderablePatchText({
      kind: "raw",
      text: "not a parseable diff",
      reason: "Showing raw patch.",
    });

    expect(serialized).toBe("not a parseable diff");
  });

  it("returns null when there is nothing to copy", () => {
    expect(serializeRenderablePatchText(null)).toBeNull();
    expect(serializeRenderablePatchText({ kind: "files", files: [] })).toBeNull();
  });
});

describe("summarizePatchStats", () => {
  it("summarizes additions and deletions from a unified patch", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,4 @@",
      " const stable = true;",
      "-const oldValue = 1;",
      "+const newValue = 1;",
      "+const addedValue = 2;",
      " export { stable };",
      "",
    ].join("\n");

    expect(summarizePatchStats(patch)).toEqual({ additions: 2, deletions: 1 });
  });
});
