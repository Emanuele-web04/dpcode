/**
 * Codex config helpers.
 *
 * Parses the small subset of `CODEX_HOME/config.toml` we need for provider
 * discovery without pulling in a full TOML dependency.
 */
import OS from "node:os";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function readQuotedAssignmentValue(trimmedLine: string, key: string): string | undefined {
  const match = trimmedLine.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`));
  return match?.[1] ?? match?.[2];
}

function readModelProviderSectionName(trimmedLine: string): string | undefined {
  const match = trimmedLine.match(
    /^\[\s*model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function readConfiguredEnvPath(
  env: NodeJS.ProcessEnv,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const configured = env[key]?.trim();
    if (configured) {
      return configured;
    }
  }

  return undefined;
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envPathKeyFor(env: NodeJS.ProcessEnv): "PATH" | "Path" | "path" {
  if ("PATH" in env) return "PATH";
  if ("Path" in env) return "Path";
  return "path";
}

function compareVersionSegments(a: string, b: string): number {
  const aSegments = a
    .replace(/^v/i, "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10) || 0);
  const bSegments = b
    .replace(/^v/i, "")
    .split(".")
    .map((segment) => Number.parseInt(segment, 10) || 0);
  const segmentCount = Math.max(aSegments.length, bSegments.length);

  for (let index = 0; index < segmentCount; index += 1) {
    const difference = (bSegments[index] ?? 0) - (aSegments[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

function listInstalledNodeVersions(baseDirectory: string): ReadonlyArray<string> {
  if (!existsSync(baseDirectory)) {
    return [];
  }

  return readdirSync(baseDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted(compareVersionSegments);
}

function resolveExecutableOnPath(commandName: string, env: NodeJS.ProcessEnv): string | undefined {
  const envPath = env[envPathKeyFor(env)]?.trim();
  if (!envPath) {
    return undefined;
  }

  for (const entry of envPath.split(process.platform === "win32" ? ";" : ":")) {
    const directory = entry.trim();
    if (!directory) {
      continue;
    }

    const candidatePath = join(directory, commandName);
    if (isExecutableFile(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

function listCodexBinaryCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const home = env.HOME?.trim() || OS.homedir();
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  const nvmVersions = listInstalledNodeVersions(join(home, ".nvm", "versions", "node"));
  const fnmVersions = listInstalledNodeVersions(join(home, ".fnm", "node-versions"));

  return [
    join(home, ".local", "bin", "codex"),
    join(home, ".volta", "bin", "codex"),
    join(home, ".asdf", "shims", "codex"),
    join(xdgDataHome, "mise", "shims", "codex"),
    ...nvmVersions.map((version) =>
      join(home, ".nvm", "versions", "node", version, "bin", "codex"),
    ),
    ...fnmVersions.map((version) =>
      join(home, ".fnm", "node-versions", version, "installation", "bin", "codex"),
    ),
  ];
}

function prependPathEntry(env: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const envPathKey = envPathKeyFor(env);
  const inheritedPath = env[envPathKey]?.trim();
  const delimiter = process.platform === "win32" ? ";" : ":";
  return {
    ...env,
    [envPathKey]: inheritedPath ? `${directory}${delimiter}${inheritedPath}` : directory,
  };
}

export function parseCodexConfigModelProvider(content: string): string | undefined {
  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const provider = readQuotedAssignmentValue(trimmed, "model_provider");
    if (provider) return provider;
  }

  return undefined;
}

export function parseCodexConfigProviderEnvKey(
  content: string,
  provider: string,
): string | undefined {
  let currentProviderSection: string | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      currentProviderSection = readModelProviderSectionName(trimmed);
      continue;
    }

    if (currentProviderSection !== provider) continue;

    const envKey = readQuotedAssignmentValue(trimmed, "env_key");
    if (envKey) return envKey;
  }

  return undefined;
}

export function parseCodexConfigActiveProviderEnvKey(content: string): string | undefined {
  const provider = parseCodexConfigModelProvider(content);
  if (!provider || provider === "openai") {
    return undefined;
  }

  return parseCodexConfigProviderEnvKey(content, provider);
}

export function readConfiguredCodexBinaryPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readConfiguredEnvPath(env, ["CODEX_BINARY_PATH"]);
}

export function findCodexBinaryPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const binaryOnPath = resolveExecutableOnPath("codex", env);
  if (binaryOnPath) {
    return binaryOnPath;
  }

  for (const candidatePath of listCodexBinaryCandidates(env)) {
    if (isExecutableFile(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

export function resolveCodexBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return readConfiguredCodexBinaryPath(env) ?? findCodexBinaryPath(env) ?? "codex";
}

export function applyCodexBinaryToPath(
  env: NodeJS.ProcessEnv,
  binaryPath: string | undefined,
): NodeJS.ProcessEnv {
  if (!binaryPath || !isAbsolute(binaryPath)) {
    return env;
  }

  return prependPathEntry(env, dirname(binaryPath));
}

export function readConfiguredCodexHomePath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readConfiguredEnvPath(env, ["CODEX_HOME", "CODEX_HOME_PATH"]);
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return readConfiguredCodexHomePath(env) ?? join(OS.homedir(), ".codex");
}

export function readCodexConfigContent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configPath = join(resolveCodexHome(env), "config.toml");
  if (!existsSync(configPath)) {
    return undefined;
  }

  return readFileSync(configPath, "utf8");
}

export function readActiveCodexProviderEnvKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const content = readCodexConfigContent(env);
  if (content === undefined) {
    return undefined;
  }

  return parseCodexConfigActiveProviderEnvKey(content);
}
