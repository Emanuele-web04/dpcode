import { describe, expect, it } from "vitest";

import {
  buildWorkspaceImagePreviewUrl,
  extractGeneratedImageArtifacts,
} from "./generatedImageArtifacts";

describe("generated image artifacts", () => {
  it("extracts unique generated image paths from assistant text", () => {
    const artifacts = extractGeneratedImageArtifacts({
      text: `Saved image:\n/Users/dev/project/codex-imagen-output/result.png\nAlso ./out/hero.webp.`,
      workspaceRoot: "/Users/dev/project",
      messageId: "message-1",
    });

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      "/Users/dev/project/codex-imagen-output/result.png",
      "./out/hero.webp",
    ]);
    expect(artifacts[0]?.name).toBe("result.png");
  });

  it("builds workspace image preview URLs with encoded parameters", () => {
    expect(
      buildWorkspaceImagePreviewUrl({
        workspaceRoot: "/Users/dev/My Project",
        path: "./codex-imagen-output/result image.png",
      }),
    ).toBe(
      "/workspace-image-preview?cwd=%2FUsers%2Fdev%2FMy+Project&path=.%2Fcodex-imagen-output%2Fresult+image.png",
    );
  });

  it("uses the Codex temp workspace root for Codex-generated absolute image paths", () => {
    const artifacts = extractGeneratedImageArtifacts({
      text: `Generated: /private/tmp/dpcode-codex-workspaces/thread-123/codex-imagen-output/result.png`,
      workspaceRoot: "/Users/dev/project",
      messageId: "message-2",
    });

    expect(artifacts[0]?.previewUrl).toBe(
      "/workspace-image-preview?cwd=%2Fprivate%2Ftmp%2Fdpcode-codex-workspaces%2Fthread-123&path=%2Fprivate%2Ftmp%2Fdpcode-codex-workspaces%2Fthread-123%2Fcodex-imagen-output%2Fresult.png",
    );
  });
});
