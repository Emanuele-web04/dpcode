import { describe, expect, it } from "vitest";

import { buildStartupCommand, isRemoteHealthReady, quotePosix } from "./remoteSshBackend";

describe("remoteSshBackend", () => {
  it("quotes shell values for remote startup commands", () => {
    expect(quotePosix("plain")).toBe("'plain'");
    expect(quotePosix("path with spaces")).toBe("'path with spaces'");
    expect(quotePosix("it's-here")).toBe("'it'\\''s-here'");
  });

  it("builds the default remote DP Code server command", () => {
    expect(
      buildStartupCommand({
        template: undefined,
        remotePort: 53123,
        authToken: "secret-token",
        remoteProjectPath: "/srv/app",
      }),
    ).toBe(
      "cd '/srv/app' && t3 --mode desktop --host 127.0.0.1 --port 53123 --auth-token 'secret-token' --no-browser",
    );
  });

  it("fills startup command placeholders", () => {
    expect(
      buildStartupCommand({
        template:
          "cd {remoteProjectPath} && t3 --port {port} --auth-token {token} --no-browser",
        remotePort: 53123,
        authToken: "secret-token",
        remoteProjectPath: "/srv/my app",
      }),
    ).toBe("cd '/srv/my app' && t3 --port 53123 --auth-token 'secret-token' --no-browser");
  });

  it("requires remote /health to be ok and startupReady", async () => {
    await expect(
      isRemoteHealthReady(
        new Response(JSON.stringify({ startupReady: true }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).resolves.toBe(false);

    await expect(
      isRemoteHealthReady(
        new Response(JSON.stringify({ startupReady: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).resolves.toBe(false);

    await expect(
      isRemoteHealthReady(
        new Response(JSON.stringify({ startupReady: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ).resolves.toBe(true);
  });
});
