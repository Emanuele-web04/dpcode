import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";

import type {
  RemoteSshConnectInput,
  RemoteSshConnectionResult,
  RemoteSshStatus,
} from "@t3tools/contracts";

import { waitForHttpReady } from "./backendReadiness";
import { reserveLoopbackPort } from "./loopbackPort";

const DEFAULT_REMOTE_PORT_MIN = 43000;
const DEFAULT_REMOTE_PORT_SPAN = 12000;
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

export interface RemoteSshBackendLifecycleEvent {
  status: RemoteSshStatus;
  previousSession: {
    target: string;
    remoteProjectPath: string;
    httpUrl: string;
    wsUrl: string;
  };
}

type RemoteSshBackendLifecycleListener = (event: RemoteSshBackendLifecycleEvent) => void;

interface ActiveRemoteSession {
  target: string;
  remoteProjectPath: string;
  remotePort: number;
  localPort: number;
  authToken: string;
  httpUrl: string;
  wsUrl: string;
  serverProcess: ChildProcess.ChildProcess;
  tunnelProcess: ChildProcess.ChildProcess;
}

interface SshProcessDiagnostics {
  label: string;
  stderr: string;
}

function trimRequired(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required.`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new Error(`${label} cannot contain newlines.`);
  }
  return trimmed;
}

export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function chooseRemotePort(input: number | undefined): number {
  if (input !== undefined) {
    if (!Number.isInteger(input) || input <= 0 || input > 65535) {
      throw new Error("Remote port must be a valid TCP port.");
    }
    return input;
  }
  return DEFAULT_REMOTE_PORT_MIN + Crypto.randomInt(DEFAULT_REMOTE_PORT_SPAN);
}

function buildDefaultStartupCommand(input: {
  readonly remotePort: number;
  readonly authToken: string;
  readonly remoteProjectPath: string;
}): string {
  const command = [
    "t3",
    "--mode",
    "desktop",
    "--host",
    "127.0.0.1",
    "--port",
    String(input.remotePort),
    "--auth-token",
    quotePosix(input.authToken),
    "--no-browser",
  ].join(" ");
  return `cd ${quotePosix(input.remoteProjectPath)} && ${command}`;
}

export function buildStartupCommand(input: {
  readonly template: string | undefined;
  readonly remotePort: number;
  readonly authToken: string;
  readonly remoteProjectPath: string;
}): string {
  const template = input.template?.trim();
  const command =
    template && template.length > 0
      ? template
      : buildDefaultStartupCommand({
          remotePort: input.remotePort,
          authToken: input.authToken,
          remoteProjectPath: input.remoteProjectPath,
        });
  return command
    .replaceAll("{port}", String(input.remotePort))
    .replaceAll("{token}", quotePosix(input.authToken))
    .replaceAll("{remoteProjectPath}", quotePosix(input.remoteProjectPath));
}

export async function isRemoteHealthReady(response: Response): Promise<boolean> {
  if (!response.ok) {
    return false;
  }
  try {
    const payload = (await response.json()) as {
      startupReady?: unknown;
    };
    return payload.startupReady === true;
  } catch {
    return false;
  }
}

function createRemoteServerProcess(input: {
  readonly target: string;
  readonly command: string;
}): ChildProcess.ChildProcess {
  return ChildProcess.spawn("ssh", [...SSH_OPTIONS, "-T", input.target, input.command], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function createTunnelProcess(input: {
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

function stopProcess(child: ChildProcess.ChildProcess | null | undefined): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
}

function sessionSummary(session: ActiveRemoteSession): RemoteSshBackendLifecycleEvent["previousSession"] {
  return {
    target: session.target,
    remoteProjectPath: session.remoteProjectPath,
    httpUrl: session.httpUrl,
    wsUrl: session.wsUrl,
  };
}

function appendBounded(buffer: string, chunk: Buffer | string): string {
  const next = `${buffer}${chunk.toString()}`;
  if (Buffer.byteLength(next) <= SSH_ERROR_BUFFER_MAX_BYTES) {
    return next;
  }
  return next.slice(-SSH_ERROR_BUFFER_MAX_BYTES);
}

function captureSshDiagnostics(
  child: ChildProcess.ChildProcess,
  label: string,
): SshProcessDiagnostics {
  const diagnostics: SshProcessDiagnostics = { label, stderr: "" };
  child.stderr?.on("data", (chunk: Buffer | string) => {
    diagnostics.stderr = appendBounded(diagnostics.stderr, chunk);
  });
  return diagnostics;
}

function cleanSshStderr(stderr: string): string {
  return stderr.replace(/\s+/g, " ").trim();
}

function sshFailureMessage(input: {
  readonly diagnostics: SshProcessDiagnostics;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}): string {
  const exitReason =
    input.code !== null
      ? `exit code ${input.code}`
      : input.signal !== null
        ? `signal ${input.signal}`
        : "unknown exit";
  const stderr = cleanSshStderr(input.diagnostics.stderr);
  return stderr.length > 0
    ? `${input.diagnostics.label} failed (${exitReason}): ${stderr}`
    : `${input.diagnostics.label} failed (${exitReason}). Check SSH target, key auth, and remote command.`;
}

function waitForProcessFailure(
  child: ChildProcess.ChildProcess,
  diagnostics: SshProcessDiagnostics,
): { promise: Promise<never>; dispose: () => void } {
  let settled = false;
  let rejectPromise: (error: Error) => void = () => {};

  const cleanup = () => {
    child.off("error", onError);
    child.off("exit", onExit);
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
    fail(new Error(`${diagnostics.label} failed: ${error.message}`));
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    fail(new Error(sshFailureMessage({ diagnostics, code, signal })));
  };

  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return {
    promise,
    dispose: cleanup,
  };
}

function statusFromSession(session: ActiveRemoteSession | null): RemoteSshStatus {
  if (!session) {
    return {
      mode: "local",
      target: null,
      remoteProjectPath: null,
      httpUrl: null,
      wsUrl: null,
      message: null,
    };
  }
  return {
    mode: "remote",
    target: session.target,
    remoteProjectPath: session.remoteProjectPath,
    httpUrl: session.httpUrl,
    wsUrl: session.wsUrl,
    message: null,
  };
}

export class RemoteSshBackendManager {
  private session: ActiveRemoteSession | null = null;
  private status: RemoteSshStatus = statusFromSession(null);
  private connectInFlight = false;
  private sessionGeneration = 0;
  private readonly lifecycleListeners = new Set<RemoteSshBackendLifecycleListener>();

  getStatus(): RemoteSshStatus {
    return this.status;
  }

  getActiveTarget(): string | null {
    return this.session?.target ?? null;
  }

  subscribeLifecycle(listener: RemoteSshBackendLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  }

  async connect(input: RemoteSshConnectInput): Promise<RemoteSshConnectionResult> {
    if (this.connectInFlight) {
      throw new Error("Remote SSH connection is already in progress.");
    }
    this.connectInFlight = true;
    try {
      return await this.connectInternal(input);
    } finally {
      this.connectInFlight = false;
    }
  }

  private async connectInternal(input: RemoteSshConnectInput): Promise<RemoteSshConnectionResult> {
    const target = trimRequired(input.target, "SSH target");
    const remoteProjectPath = trimRequired(input.remoteProjectPath, "Remote project path");
    await this.disconnect();
    const generation = ++this.sessionGeneration;

    const remotePort = chooseRemotePort(input.remotePort);
    const localPort = await reserveLoopbackPort();
    const authToken = Crypto.randomBytes(24).toString("hex");
    const httpUrl = `http://127.0.0.1:${localPort}`;
    const wsUrl = `ws://127.0.0.1:${localPort}/?token=${encodeURIComponent(authToken)}`;
    const command = buildStartupCommand({
      template: input.startupCommand,
      remotePort,
      authToken,
      remoteProjectPath,
    });

    this.status = {
      mode: "connecting",
      target,
      remoteProjectPath,
      httpUrl,
      wsUrl,
      message: "Starting remote DP Code server...",
    };

    const serverProcess = createRemoteServerProcess({ target, command });
    const tunnelProcess = createTunnelProcess({ target, localPort, remotePort });
    const serverDiagnostics = captureSshDiagnostics(serverProcess, "Remote DP Code server SSH");
    const tunnelDiagnostics = captureSshDiagnostics(tunnelProcess, "Remote SSH tunnel");
    const nextSession: ActiveRemoteSession = {
      target,
      remoteProjectPath,
      remotePort,
      localPort,
      authToken,
      httpUrl,
      wsUrl,
      serverProcess,
      tunnelProcess,
    };

    let ready = false;
    const failActiveSession = (message: string, notifyLifecycle: boolean) => {
      if (this.session !== nextSession || this.sessionGeneration !== generation) {
        return;
      }
      const previousSession = sessionSummary(nextSession);
      this.session = null;
      stopProcess(serverProcess);
      stopProcess(tunnelProcess);
      this.status = {
        mode: "error",
        target,
        remoteProjectPath,
        httpUrl,
        wsUrl,
        message,
      };
      if (notifyLifecycle) {
        this.emitLifecycle({ status: this.status, previousSession });
      }
    };
    const onServerExit = (code: number | null, signal: NodeJS.Signals | null) => {
      failActiveSession(sshFailureMessage({ diagnostics: serverDiagnostics, code, signal }), ready);
    };
    const onTunnelExit = (code: number | null, signal: NodeJS.Signals | null) => {
      failActiveSession(sshFailureMessage({ diagnostics: tunnelDiagnostics, code, signal }), ready);
    };
    const onError = (error: Error) => {
      failActiveSession(error.message, ready);
    };
    serverProcess.once("error", onError);
    tunnelProcess.once("error", onError);
    serverProcess.once("exit", onServerExit);
    tunnelProcess.once("exit", onTunnelExit);
    this.session = nextSession;
    const serverFailure = waitForProcessFailure(serverProcess, serverDiagnostics);
    const tunnelFailure = waitForProcessFailure(tunnelProcess, tunnelDiagnostics);

    try {
      await Promise.race([
        waitForHttpReady(httpUrl, {
          path: "/health",
          timeoutMs: 45_000,
          isReady: isRemoteHealthReady,
        }),
        serverFailure.promise,
        tunnelFailure.promise,
      ]);
    } catch (error) {
      serverFailure.dispose();
      tunnelFailure.dispose();
      stopProcess(serverProcess);
      stopProcess(tunnelProcess);
      if (this.session === nextSession && this.sessionGeneration === generation) {
        this.session = null;
      }
      const message = error instanceof Error ? error.message : "Remote SSH connection failed.";
      if (this.sessionGeneration === generation) {
        this.status = {
          mode: "error",
          target,
          remoteProjectPath,
          httpUrl,
          wsUrl,
          message,
        };
      }
      throw new Error(message);
    }
    serverFailure.dispose();
    tunnelFailure.dispose();

    if (this.session !== nextSession || this.sessionGeneration !== generation) {
      stopProcess(serverProcess);
      stopProcess(tunnelProcess);
      throw new Error("Remote SSH connection was cancelled.");
    }

    ready = true;
    this.status = statusFromSession(nextSession);
    return {
      mode: "remote",
      target,
      remoteProjectPath,
      httpUrl,
      wsUrl,
    };
  }

  async disconnect(): Promise<RemoteSshStatus> {
    this.sessionGeneration += 1;
    const current = this.session;
    this.session = null;
    stopProcess(current?.serverProcess);
    stopProcess(current?.tunnelProcess);
    this.status = statusFromSession(null);
    return this.status;
  }

  private emitLifecycle(event: RemoteSshBackendLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch {
        // Lifecycle listeners must not prevent process cleanup after an SSH failure.
      }
    }
  }
}
