import * as ChildProcess from "node:child_process";
import * as Net from "node:net";

import { reserveLoopbackPort } from "./loopbackPort";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const SSH_ERROR_BUFFER_MAX_BYTES = 16 * 1024;
const SSH_CONNECT_TIMEOUT_SECONDS = 10;
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
] as const;

interface ForwardedPort {
  remotePort: number;
  localPort: number;
  process: ChildProcess.ChildProcess;
}

interface SshProcessDiagnostics {
  stderr: string;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

function defaultPortForProtocol(protocol: string): number | null {
  if (protocol === "http:" || protocol === "ws:") return 80;
  if (protocol === "https:" || protocol === "wss:") return 443;
  return null;
}

function createSshTunnelProcess(input: {
  readonly target: string;
  readonly localPort: number;
  readonly remotePort: number;
}): ChildProcess.ChildProcess {
  return ChildProcess.spawn(
    "ssh",
    [
      "-N",
      "-T",
      ...SSH_OPTIONS,
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      "-L",
      `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
      input.target,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

function appendBounded(buffer: string, chunk: Buffer | string): string {
  const next = `${buffer}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= SSH_ERROR_BUFFER_MAX_BYTES) {
    return next;
  }
  return next.slice(-SSH_ERROR_BUFFER_MAX_BYTES);
}

function captureSshDiagnostics(child: ChildProcess.ChildProcess): SshProcessDiagnostics {
  const diagnostics: SshProcessDiagnostics = { stderr: "" };
  child.stderr?.on("data", (chunk: Buffer | string) => {
    diagnostics.stderr = appendBounded(diagnostics.stderr, chunk);
  });
  return diagnostics;
}

function cleanSshStderr(stderr: string): string {
  return stderr.replace(/\s+/g, " ").trim();
}

async function waitForLocalPort(port: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = Net.createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 250);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (connected) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for SSH port forward on 127.0.0.1:${port}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function waitForTunnelExit(input: {
  readonly process: ChildProcess.ChildProcess;
  readonly remotePort: number;
  readonly diagnostics: SshProcessDiagnostics;
}): { promise: Promise<never>; dispose: () => void } {
  let settled = false;
  let rejectPromise: (error: Error) => void = () => {};

  const cleanup = () => {
    input.process.off("error", onError);
    input.process.off("exit", onExit);
  };
  const fail = (error: Error) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    rejectPromise(error);
  };
  const onError = (error: Error) => {
    fail(new Error(`SSH port forward for remote port ${input.remotePort} failed: ${error.message}`));
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    const exitReason =
      code !== null ? `exit code ${code}` : signal !== null ? `signal ${signal}` : "unknown exit";
    const stderr = cleanSshStderr(input.diagnostics.stderr);
    const suffix =
      stderr.length > 0 ? `: ${stderr}` : ". Check SSH target, key auth, and remote port.";
    fail(
      new Error(
        `SSH port forward for remote port ${input.remotePort} failed (${exitReason})${suffix}`,
      ),
    );
  };

  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
    input.process.once("error", onError);
    input.process.once("exit", onExit);
  });

  return {
    promise,
    dispose: cleanup,
  };
}

export class RemotePortForwarder {
  private target: string | null = null;
  private readonly forwardsByRemotePort = new Map<number, ForwardedPort>();
  private readonly pendingForwardsByRemotePort = new Map<number, Promise<ForwardedPort>>();
  private readonly logicalOriginsByLocalOrigin = new Map<string, string>();

  setTarget(target: string | null): void {
    if (this.target === target) {
      return;
    }
    this.dispose();
    this.target = target;
  }

  isActive(): boolean {
    return this.target !== null;
  }

  async resolveUrl(rawUrl: string): Promise<{ url: string }> {
    if (!this.target) {
      return { url: rawUrl };
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { url: rawUrl };
    }

    if (
      !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
      !isLoopbackHost(url.hostname)
    ) {
      return { url: rawUrl };
    }

    const remotePort = url.port
      ? Number.parseInt(url.port, 10)
      : defaultPortForProtocol(url.protocol);
    if (!remotePort || !Number.isFinite(remotePort) || remotePort <= 0) {
      return { url: rawUrl };
    }
    for (const forward of this.forwardsByRemotePort.values()) {
      if (forward.localPort === remotePort) {
        return { url: rawUrl };
      }
    }

    const logicalOrigin = url.origin;
    const forwarded = await this.ensureForward(remotePort);
    url.hostname = "127.0.0.1";
    url.port = String(forwarded.localPort);
    this.logicalOriginsByLocalOrigin.set(url.origin, logicalOrigin);
    return { url: url.toString() };
  }

  normalizeDisplayUrl(rawUrl: string): string {
    if (!this.target) {
      return rawUrl;
    }

    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const logicalOrigin = this.logicalOriginsByLocalOrigin.get(url.origin);
    if (!logicalOrigin) {
      return rawUrl;
    }

    const logicalUrl = new URL(logicalOrigin);
    url.protocol = logicalUrl.protocol;
    url.hostname = logicalUrl.hostname;
    url.port = logicalUrl.port;
    url.username = "";
    url.password = "";
    return url.toString();
  }

  dispose(): void {
    for (const forward of this.forwardsByRemotePort.values()) {
      forward.process.kill("SIGTERM");
    }
    this.target = null;
    this.forwardsByRemotePort.clear();
    this.pendingForwardsByRemotePort.clear();
    this.logicalOriginsByLocalOrigin.clear();
  }

  private async ensureForward(remotePort: number): Promise<ForwardedPort> {
    const existing = this.forwardsByRemotePort.get(remotePort);
    if (existing && existing.process.exitCode === null && existing.process.signalCode === null) {
      return existing;
    }
    const pending = this.pendingForwardsByRemotePort.get(remotePort);
    if (pending) {
      return pending;
    }

    if (!this.target) {
      throw new Error("Remote SSH forwarding is not active.");
    }

    const pendingForward = this.createForward(remotePort);
    this.pendingForwardsByRemotePort.set(remotePort, pendingForward);
    try {
      return await pendingForward;
    } finally {
      if (this.pendingForwardsByRemotePort.get(remotePort) === pendingForward) {
        this.pendingForwardsByRemotePort.delete(remotePort);
      }
    }
  }

  private async createForward(remotePort: number): Promise<ForwardedPort> {
    const target = this.target;
    if (!target) {
      throw new Error("Remote SSH forwarding is not active.");
    }
    const localPort = await reserveLoopbackPort();
    if (this.target !== target) {
      throw new Error("Remote SSH forwarding was cancelled.");
    }
    const process = createSshTunnelProcess({
      target,
      localPort,
      remotePort,
    });
    const diagnostics = captureSshDiagnostics(process);
    const forward: ForwardedPort = { remotePort, localPort, process };
    this.forwardsByRemotePort.set(remotePort, forward);
    process.once("error", () => {
      if (this.forwardsByRemotePort.get(remotePort) === forward) {
        this.forwardsByRemotePort.delete(remotePort);
      }
    });
    process.once("exit", () => {
      if (this.forwardsByRemotePort.get(remotePort) === forward) {
        this.forwardsByRemotePort.delete(remotePort);
      }
    });
    const tunnelExit = waitForTunnelExit({ process, remotePort, diagnostics });
    try {
      await Promise.race([waitForLocalPort(localPort), tunnelExit.promise]);
    } catch (error) {
      tunnelExit.dispose();
      process.kill("SIGTERM");
      if (this.forwardsByRemotePort.get(remotePort) === forward) {
        this.forwardsByRemotePort.delete(remotePort);
      }
      throw error;
    }
    tunnelExit.dispose();
    if (this.target !== target) {
      process.kill("SIGTERM");
      if (this.forwardsByRemotePort.get(remotePort) === forward) {
        this.forwardsByRemotePort.delete(remotePort);
      }
      throw new Error("Remote SSH forwarding was cancelled.");
    }
    return forward;
  }
}
