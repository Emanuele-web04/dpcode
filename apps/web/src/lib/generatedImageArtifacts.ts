export interface GeneratedImageArtifact {
  id: string;
  path: string;
  name: string;
  previewUrl: string;
}

const IMAGE_PATH_REGEX = /(?:^|[\s"'`(])((?:~|\.|\.\.|\/|[A-Za-z]:[\\/])[^\s"'`<>)]+\.(?:png|jpe?g|webp|gif))(?:$|[\s"'`),.])/gi;
const TRAILING_PATH_PUNCTUATION_REGEX = /[),.;:]+$/;
const CODEX_WORKSPACE_SEGMENT = "/dpcode-codex-workspaces/";

export function basenameOfGeneratedImagePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

export function buildWorkspaceImagePreviewUrl(input: {
  workspaceRoot: string;
  path: string;
}): string {
  const params = new URLSearchParams({
    cwd: input.workspaceRoot,
    path: input.path,
  });
  return `/workspace-image-preview?${params.toString()}`;
}

function previewRootForGeneratedImagePath(path: string, fallbackWorkspaceRoot: string): string {
  const normalized = path.replaceAll("\\", "/");
  const markerIndex = normalized.indexOf(CODEX_WORKSPACE_SEGMENT);
  if (markerIndex === -1) {
    return fallbackWorkspaceRoot;
  }

  const workspaceIdStart = markerIndex + CODEX_WORKSPACE_SEGMENT.length;
  const workspaceIdEnd = normalized.indexOf("/", workspaceIdStart);
  if (workspaceIdEnd === -1) {
    return fallbackWorkspaceRoot;
  }
  return path.slice(0, workspaceIdEnd);
}

export function extractGeneratedImageArtifacts(input: {
  text: string;
  workspaceRoot: string | undefined;
  messageId: string;
}): GeneratedImageArtifact[] {
  if (!input.workspaceRoot) return [];

  const seen = new Set<string>();
  const artifacts: GeneratedImageArtifact[] = [];
  for (const match of input.text.matchAll(IMAGE_PATH_REGEX)) {
    const rawPath = match[1]?.trim().replace(TRAILING_PATH_PUNCTUATION_REGEX, "");
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    const previewWorkspaceRoot = previewRootForGeneratedImagePath(rawPath, input.workspaceRoot);
    artifacts.push({
      id: `${input.messageId}:${artifacts.length}:${rawPath}`,
      path: rawPath,
      name: basenameOfGeneratedImagePath(rawPath),
      previewUrl: buildWorkspaceImagePreviewUrl({
        workspaceRoot: previewWorkspaceRoot,
        path: rawPath,
      }),
    });
  }
  return artifacts;
}
