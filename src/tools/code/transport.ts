/**
 * How Code Mode's worker is started, and where it runs.
 *
 * Two implementations behind one interface, because the difference between them
 * is the whole point of this file and nothing above it should have to care:
 *
 *  - `InProcessWorkerTransport` starts the worker as a thread of the Reaper
 *    process, which is what Code Mode has always done. The script sees the
 *    whole machine: every path, every other thread's workspace.
 *  - `SandboxedWorkerTransport` starts a small relay *inside the same
 *    bubblewrap mount namespace a `bash` command gets*, and the relay owns the
 *    worker. The script now sees exactly what a shell command sees: the
 *    workspace and read-only system directories. Nothing else resolves.
 *
 * The sandboxed one is the default wherever bubblewrap can run. The in-process
 * one remains as the fallback for hosts where it cannot, which is the same
 * bargain `bash` already makes — a host without user namespaces runs commands
 * unconfined rather than refusing to run them — and the result says which one
 * ran rather than leaving the model to guess.
 *
 * The relay indirection exists because a worker started with `eval: true` takes
 * its program through `workerData`, an in-process channel a process on the
 * outside cannot reach. The host writes the relay's source into the workspace
 * scratch, runs it with bubblewrap, and speaks to it over a unix socket bound
 * into the namespace. Frames are `node:v8`-serialized so the values that travel
 * are the same values `postMessage` would carry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { Worker } from "node:worker_threads";

import { buildSandboxedNodeCommand, resolveBubblewrap } from "../../policy/shell-sandbox.js";
import { dependencyBinds } from "./dependency-bind.js";
import { CODE_MODE_RELAY_SOURCE } from "./sandbox-relay.js";
import type { CodeConsoleEntry } from "./types.js";

/** What the worker sends us. Mirrors the postMessage shapes in worker-source. */
export type WorkerMessage =
  | { type: "console"; level: CodeConsoleEntry["level"]; text: string }
  | { type: "consoleTruncated" }
  | { type: "tool"; id: number; name: string; args: unknown }
  | { type: "model"; id: number; args: unknown }
  | { type: "child"; pid: number }
  | { type: "done"; value: unknown }
  | { type: "failed"; error: { name: string; message: string; stack?: string; code?: string; tool?: string } };

export interface WorkerTransport {
  postMessage(message: unknown): void;
  onMessage(listener: (message: WorkerMessage) => void): void;
  onError(listener: (error: Error & { code?: string }) => void): void;
  onExit(listener: (code: number) => void): void;
  /** Stop the worker. Synchronous by contract: callers do not await it. */
  terminate(): void;
  /** Let the worker not keep the host process alive. */
  unref(): void;
}

export interface WorkerTransportRequest {
  /** The program the worker runs. In-process this is the Worker's own source;
   *  sandboxed it is sent to the relay, which starts the worker with it. */
  workerSource: string;
  workerData: Record<string, unknown>;
  resourceLimits: { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number };
  execArgv: string[];
  /** The environment for the script's child processes (credentials stripped). */
  env: NodeJS.ProcessEnv;
}

/** Where a sandboxed Code Mode run keeps the relay it runs. */
export function codeModeSandboxPaths(workspaceRoot: string): { relayPath: string } {
  const base = path.join(path.resolve(workspaceRoot), ".reaper", "sandbox", "codemode");
  return { relayPath: path.join(base, "relay.cjs") };
}

/** The mount point the relay sees the socket directory at, kept short. */
export const CODE_MODE_IPC_MOUNT = "/reaper-ipc";

/**
 * Why the socket does not live in the workspace.
 *
 * A unix socket path is capped at 108 bytes by the kernel, and a workspace path
 * is not bounded by anything Reaper controls — a thread under a deep project
 * directory blew the limit and the failure was `listen EINVAL`, which reads as
 * a bad argument rather than as a too-long path. A short directory under the
 * system temp dir keeps the host side well inside the cap, and the relay sees
 * the socket at a fixed short mount point regardless of how deep the workspace
 * is, so neither side can exceed it.
 */
function ipcDirectory(): string {
  return path.join(os.tmpdir(), `reaper-ipc-${randomUUID().slice(0, 8)}`);
}

/**
 * Whether the Node binary this process runs under is reachable inside the
 * sandbox, which it is only when it lives under a read-only system directory.
 *
 * A Node installed under a user's home or a version manager is not, and a
 * sandboxed run would fail to exec with a message about a missing file rather
 * than about a missing mount. Answering the question here lets the caller fall
 * back to the in-process runtime instead of producing that.
 */
function nodeInsideSandbox(): string | undefined {
  const candidate = process.execPath;
  if (!path.isAbsolute(candidate)) return undefined;
  const visible = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32", "/etc", "/opt"];
  return visible.some((dir) => candidate === dir || candidate.startsWith(`${dir}${path.sep}`)) ? candidate : undefined;
}

/** True when a sandboxed eval can be attempted on this host. */
export function sandboxAvailableForEval(): boolean {
  return resolveBubblewrap() !== undefined && nodeInsideSandbox() !== undefined;
}

/**
 * Start a worker as a thread of this process.
 *
 * The env is set on the worker rather than inherited, for the reason spelled
 * out where it used to live: a Worker inherits the parent's environment by
 * default, which would hand the model's script Reaper's own provider keys.
 */
async function createInProcessTransport(request: WorkerTransportRequest): Promise<WorkerTransport> {
  const worker = new Worker(request.workerSource, {
    eval: true,
    workerData: request.workerData,
    resourceLimits: request.resourceLimits,
    stdout: false,
    stderr: false,
    env: request.env,
    execArgv: request.execArgv,
  });
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.on("message", listener as (value: unknown) => void),
    onError: (listener) => worker.on("error", listener),
    onExit: (listener) => worker.on("exit", listener),
    terminate: () => void worker.terminate(),
    unref: () => worker.unref(),
  };
}

/** Framing shared with the relay: a 4-byte length, then a v8-serialized value. */
function frame(value: unknown): Buffer {
  const payload = v8.serialize(value);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Start a worker inside a bubblewrap namespace, with a relay carrying frames.
 *
 * The wait for the relay's connection is bounded. A relay that never connects,
 * or a bubblewrap that fails to create the namespace, would otherwise leave a
 * caller awaiting a promise nothing will settle; the failure rejects so the
 * caller can fall back to the in-process runtime.
 */
async function createSandboxedTransport(
  workspaceRoot: string,
  request: WorkerTransportRequest,
): Promise<WorkerTransport> {
  const nodePath = nodeInsideSandbox();
  if (!nodePath) throw new Error("node is not visible inside the sandbox");

  const { relayPath } = codeModeSandboxPaths(workspaceRoot);
  mkdirSync(path.dirname(relayPath), { recursive: true });
  /*
   * The relay is written into the workspace because the namespace can only load
   * it from a path it can see, and the workspace is the one directory it mounts
   * read-write. Written every time rather than only when absent: the file is
   * small and the write is cheap, and a stale relay from an earlier version of
   * Reaper is a bug that would present as a mystifying protocol mismatch rather
   * than as anything pointing here.
   */
  writeFileSync(relayPath, CODE_MODE_RELAY_SOURCE);

  const ipcDir = ipcDirectory();
  mkdirSync(ipcDir, { recursive: true });
  const socketName = `r.sock`;
  const hostSocketPath = path.join(ipcDir, socketName);
  const sandboxSocketPath = path.join(CODE_MODE_IPC_MOUNT, socketName);

  return await new Promise<WorkerTransport>((resolve, reject) => {
    const messageListeners: Array<(m: WorkerMessage) => void> = [];
    const errorListeners: Array<(e: Error & { code?: string }) => void> = [];
    const exitListeners: Array<(code: number) => void> = [];
    let child: ChildProcess | undefined;
    let connection: net.Socket | undefined;
    let closed = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

    const emitError = (error: Error & { code?: string }): void => {
      for (const listener of errorListeners) listener(error);
    };
    const emitExit = (code: number): void => {
      for (const listener of exitListeners) listener(code);
    };

    const transport: WorkerTransport = {
      postMessage: (message) => {
        if (!connection || connection.destroyed) return;
        try {
          connection.write(frame(message));
        } catch {
          /* The relay is gone; the close handler is what reports that. */
        }
      },
      onMessage: (listener) => void messageListeners.push(listener),
      onError: (listener) => void errorListeners.push(listener),
      onExit: (listener) => void exitListeners.push(listener),
      terminate: () => {
        if (closed) return;
        closed = true;
        if (connection && !connection.destroyed) {
          try {
            connection.write(frame({ type: "shutdown" }));
          } catch {
            /* ignore */
          }
        }
        server.close();
        /*
         * `--die-with-parent` is what makes the SIGKILL below reach the relay:
         * the process this handle points at is bubblewrap's supervisor, and the
         * relay is its child, which that flag ties to its parent's lifetime.
         * The grace period is for the ordinary path where the relay exits on
         * the `shutdown` frame first; the kill is for a relay that will not.
         */
        const kill = setTimeout(() => {
          try {
            child?.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          connection?.destroy();
          try {
            rmSync(ipcDir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }, 250);
        kill.unref?.();
      },
      unref: () => void child?.unref(),
    };

    const server = net.createServer((socket) => {
      if (connection) {
        /* A second connection is not something the protocol has a use for. */
        socket.destroy();
        return;
      }
      connection = socket;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      let inbound = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        inbound = Buffer.concat([inbound, chunk]);
        while (inbound.length >= 4) {
          const size = inbound.readUInt32BE(0);
          if (inbound.length < 4 + size) break;
          const body = inbound.subarray(4, 4 + size);
          inbound = inbound.subarray(4 + size);
          let message: WorkerMessage;
          try {
            message = v8.deserialize(body) as WorkerMessage;
          } catch {
            continue;
          }
          const kind = (message as { type?: string }).type;
          if (kind === "ready") {
            socket.write(frame({
              type: "start",
              workerSource: request.workerSource,
              workerData: request.workerData,
              resourceLimits: request.resourceLimits,
              execArgv: request.execArgv,
            }));
            continue;
          }
          if (kind === "workerError") {
            const detail = (message as unknown as { error?: { name?: string; message?: string; code?: string } }).error;
            const error = Object.assign(new Error(detail?.message ?? "the eval worker failed"), {
              ...(detail?.name ? { name: detail.name } : {}),
              ...(detail?.code ? { code: detail.code } : {}),
            });
            emitError(error as Error & { code?: string });
            continue;
          }
          if (kind === "workerExit") {
            emitExit((message as unknown as { code?: number }).code ?? 0);
            continue;
          }
          for (const listener of messageListeners) listener(message);
        }
      });
      socket.on("error", (error) => emitError(error as Error & { code?: string }));
      /*
       * The relay going away without a worker `done` has to read as an exit, or
       * the run never settles and the model waits on a turn that ended.
       */
      socket.on("close", () => {
        if (closed) return;
        closed = true;
        emitExit(0);
      });
    });

    server.on("error", (error) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      reject(error);
    });

    server.listen(hostSocketPath, () => {
      const sandboxed = buildSandboxedNodeCommand({
        workspaceRoot,
        workingDirectory: workspaceRoot,
        nodePath,
        scriptPath: relayPath,
        /*
         * The IPC directory, plus the harness's dependencies read-only.
         *
         * The dependency bind is what lets a script `require('playwright')` and
         * anything else the agent installs into the package tree. It goes in
         * read-only so a script cannot rewrite the library the next script
         * loads. `buildSandboxedNodeCommand` derives `NODE_PATH` from these
         * binds, so a mount without the variable — a silent MODULE_NOT_FOUND —
         * is not a state this can reach.
         */
        extraBinds: [
          { source: ipcDir, target: CODE_MODE_IPC_MOUNT },
          ...dependencyBinds(),
        ],
      });
      if (!sandboxed) {
        server.close();
        reject(new Error("bubblewrap is not available"));
        return;
      }
      child = spawn(sandboxed.command, sandboxed.args, {
        cwd: workspaceRoot,
        env: { ...request.env, REAPER_CODE_IPC: sandboxSocketPath },
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", (error) => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        reject(error);
      });
      /* Resolving on the relay's connection is what makes `postMessage` usable;
       * the promise's microtask lands before the socket's first data event, so
       * the runtime has attached its listeners by the time frames arrive. */
      const connected = setInterval(() => {
        if (!connection) return;
        clearInterval(connected);
        resolve(transport);
      }, 5);
      connected.unref?.();
      handshakeTimer = setTimeout(() => {
        clearInterval(connected);
        child?.kill("SIGKILL");
        reject(new Error("the sandboxed eval relay did not connect in time"));
      }, 10_000);
      handshakeTimer.unref?.();
    });
  });
}

/**
 * Start the worker for one eval, sandboxed where the host allows it.
 *
 * `sandboxed` is reported back so the caller can say which one ran. A sandbox
 * that cannot start is not a reason for the eval to fail: the fallback is the
 * runtime that has always been there, and the result notes the difference
 * rather than hiding it.
 */
export async function createWorkerTransport(input: {
  workspaceRoot: string | undefined;
  request: WorkerTransportRequest;
}): Promise<{ transport: WorkerTransport; sandboxed: boolean }> {
  if (input.workspaceRoot && sandboxAvailableForEval()) {
    try {
      return { transport: await createSandboxedTransport(input.workspaceRoot, input.request), sandboxed: true };
    } catch (error) {
      /* Fall through to the in-process runtime; `sandboxed: false` is the
       * caller's signal that the confinement did not happen. */
      if (process.env.REAPER_DEBUG_SANDBOX) {
        console.error("[eval-sandbox] falling back to in-process:", error);
      }
    }
  }
  return { transport: await createInProcessTransport(input.request), sandboxed: false };
}
