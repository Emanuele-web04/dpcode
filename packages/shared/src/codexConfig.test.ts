import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import OS from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCodexBinaryToPath,
  findCodexBinaryPath,
  parseCodexConfigActiveProviderEnvKey,
  parseCodexConfigModelProvider,
  parseCodexConfigProviderEnvKey,
  readConfiguredCodexBinaryPath,
  readConfiguredCodexHomePath,
  readActiveCodexProviderEnvKey,
  resolveCodexBinaryPath,
  resolveCodexHome,
} from "./codexConfig";

const tempDirs: string[] = [];

function makeTempCodexHome(configContent?: string): string {
  const tempDir = mkdtempSync(join(OS.tmpdir(), "t3-codex-config-"));
  tempDirs.push(tempDir);

  if (configContent !== undefined) {
    writeFileSync(join(tempDir, "config.toml"), configContent, "utf8");
  }

  return tempDir;
}

function writeExecutable(filePath: string, content = "#!/bin/sh\nexit 0\n"): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("parseCodexConfigModelProvider", () => {
  it("reads the top-level model provider", () => {
    expect(
      parseCodexConfigModelProvider('model = "gpt-5.3-codex"\nmodel_provider = "azure"\n'),
    ).toBe("azure");
  });

  it("ignores model_provider declarations inside nested sections", () => {
    expect(
      parseCodexConfigModelProvider(
        ["[model_providers.portkey]", 'model_provider = "should-be-ignored"'].join("\n"),
      ),
    ).toBeUndefined();
  });
});

describe("parseCodexConfigProviderEnvKey", () => {
  it("reads env_key from the matching model provider section", () => {
    expect(
      parseCodexConfigProviderEnvKey(
        [
          'model_provider = "portkey"',
          "",
          "[model_providers.portkey]",
          'env_key = "PORTKEY_API_KEY"',
        ].join("\n"),
        "portkey",
      ),
    ).toBe("PORTKEY_API_KEY");
  });

  it("supports quoted provider section names", () => {
    expect(
      parseCodexConfigProviderEnvKey(
        [
          'model_provider = "my-company-proxy"',
          "",
          '[model_providers."my-company-proxy"]',
          'env_key = "MY_COMPANY_PROXY_KEY"',
        ].join("\n"),
        "my-company-proxy",
      ),
    ).toBe("MY_COMPANY_PROXY_KEY");
  });
});

describe("parseCodexConfigActiveProviderEnvKey", () => {
  it("returns the active custom provider env_key", () => {
    expect(
      parseCodexConfigActiveProviderEnvKey(
        [
          'model_provider = "azure"',
          "",
          "[model_providers.azure]",
          'env_key = "AZURE_OPENAI_API_KEY"',
        ].join("\n"),
      ),
    ).toBe("AZURE_OPENAI_API_KEY");
  });

  it("returns undefined for the default openai provider", () => {
    expect(parseCodexConfigActiveProviderEnvKey('model_provider = "openai"\n')).toBeUndefined();
  });
});

describe("readActiveCodexProviderEnvKey", () => {
  it("reads the active env_key from CODEX_HOME/config.toml", () => {
    const codexHome = makeTempCodexHome(
      [
        'model_provider = "my-company-proxy"',
        "",
        '[model_providers."my-company-proxy"]',
        'env_key = "MY_COMPANY_PROXY_KEY"',
      ].join("\n"),
    );

    expect(readActiveCodexProviderEnvKey({ CODEX_HOME: codexHome })).toBe("MY_COMPANY_PROXY_KEY");
  });

  it("returns undefined when config.toml is missing", () => {
    const codexHome = makeTempCodexHome();
    expect(readActiveCodexProviderEnvKey({ CODEX_HOME: codexHome })).toBeUndefined();
  });
});

describe("resolveCodexBinaryPath", () => {
  it("reads CODEX_BINARY_PATH when configured", () => {
    expect(resolveCodexBinaryPath({ CODEX_BINARY_PATH: "/home/harrjyot/codex-wrapper.sh" })).toBe(
      "/home/harrjyot/codex-wrapper.sh",
    );
  });

  it("falls back to codex when no override is configured", () => {
    expect(resolveCodexBinaryPath({})).toBe("codex");
  });

  it("finds codex on PATH before scanning toolchain directories", () => {
    const home = makeTempCodexHome();
    const codexPath = join(home, "bin", "codex");
    writeExecutable(codexPath);

    expect(resolveCodexBinaryPath({ HOME: home, PATH: join(home, "bin") })).toBe(codexPath);
  });

  it("finds codex in the newest installed nvm node version", () => {
    const home = makeTempCodexHome();
    const olderCodexPath = join(home, ".nvm", "versions", "node", "v20.18.0", "bin", "codex");
    const newerCodexPath = join(home, ".nvm", "versions", "node", "v22.22.2", "bin", "codex");
    writeExecutable(olderCodexPath);
    writeExecutable(newerCodexPath);

    expect(findCodexBinaryPath({ HOME: home, PATH: "/usr/bin" })).toBe(newerCodexPath);
  });

  it("exposes the raw configured override", () => {
    expect(readConfiguredCodexBinaryPath({ CODEX_BINARY_PATH: " /tmp/custom-codex " })).toBe(
      "/tmp/custom-codex",
    );
  });
});

describe("applyCodexBinaryToPath", () => {
  it("prepends the codex binary directory when an absolute path is used", () => {
    expect(
      applyCodexBinaryToPath(
        { PATH: "/usr/bin" },
        "/home/test/.nvm/versions/node/v22.22.2/bin/codex",
      ),
    ).toEqual({
      PATH: "/home/test/.nvm/versions/node/v22.22.2/bin:/usr/bin",
    });
  });

  it("leaves PATH unchanged for bare command names", () => {
    expect(applyCodexBinaryToPath({ PATH: "/usr/bin" }, "codex")).toEqual({ PATH: "/usr/bin" });
  });
});

describe("resolveCodexHome", () => {
  it("prefers CODEX_HOME when it is configured", () => {
    expect(
      resolveCodexHome({ CODEX_HOME: "/tmp/codex-home", CODEX_HOME_PATH: "/tmp/ignored" }),
    ).toBe("/tmp/codex-home");
  });

  it("falls back to CODEX_HOME_PATH for desktop/server overrides", () => {
    expect(resolveCodexHome({ CODEX_HOME_PATH: "/tmp/codex-home-path" })).toBe(
      "/tmp/codex-home-path",
    );
  });

  it("exposes the configured home override without defaulting", () => {
    expect(readConfiguredCodexHomePath({ CODEX_HOME_PATH: " /tmp/codex-home-path " })).toBe(
      "/tmp/codex-home-path",
    );
  });
});
