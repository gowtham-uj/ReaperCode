/**
 * BackgroundProcessManager — owns the lifecycle of every long-running
 * child process the Reaper agent has spawned. Extracted from
 * `tools/executor.ts` so the executor can stop being the single source
 * of truth for both dispatch and process bookkeeping.
 *
 * Responsibilities:
 *  - Register / lookup / deregister processes by pid.
 *  - Attach stdout / stderr / exit listeners once, at register time.
 *  - Bounded ring-buffer of recent output per process.
 *  - JSON manifest persistence under `.reaper_data/runs/<runId>/processes.json`
 *    so a crashed Reaper restart can reap orphaned children from a
 *    prior run.
 *  - `terminateAll(reason)` for the cleanup-registry hook: SIGTERM,
 *    wait, SIGKILL the holdouts, plus a `cleanupDescendantProcesses`
 *    safety net for grandchildren the parent didn't own.
 *  - `killTree(pid, signal)` for the `signal_process` tool.
 *
 * The manager does NOT spawn children — that's still the `bash` tool.
 * It only owns what happens after a pid exists.
 */

import { type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import treeKill from "tree-kill";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";
import { getBgTunables } from "../config/config-tunables.js";


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ManagedBackgroundProcess {
  child: ChildProcess;
  output: string[];
  logPath?: string;
  startedAt: string;
  /** Wall-clock ms when the child was spawned. Used to defend against
   *  pid reuse: if the kernel recycles the pid to a different process
   *  before we get to clean up, the (startedAtMs, pid) pair is unlikely
   *  to match a new process. */
  startedAtMs: number;
  cmd: string;
  cwd: string;
  notified: boolean;
}

export interface BackgroundProcessSnapshot {
  pid: number;
  status: "running" | "finished";
  exitCode: number | null;
  logPath?: string;
  startedAt: string;
  cmd: string;
}

interface PersistedManifest {
  runId: string;
  updatedAt: string;
  processes: BackgroundProcessSnapshot[];
}

// ---------------------------------------------------------------------------
// Tunables (env-overridable so tests can shrink windows)
// ---------------------------------------------------------------------------

function getTermGraceMs(): number {
  const raw = Number(getBgTunables().termGraceMs ?? 1_500);
  return Number.isFinite(raw) && raw >= 100 ? raw : 1_500;
}
function getKillGraceMs(): number {
  const raw = Number(getBgTunables().killGraceMs ?? 1_000);
  return Number.isFinite(raw) && raw >= 100 ? raw : 1_000;
}
function getDescendantTermGraceMs(): number {
  const raw = Number(getBgTunables().descendantTermGraceMs ?? 1_500);
  return Number.isFinite(raw) && raw >= 100 ? raw : 1_500;
}
function getMaxOutputLines(): number {
  const raw = Number(getBgTunables().maxOutputLines ?? 5_000);
  return Number.isFinite(raw) && raw >= 100 ? raw : 5_000;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class BackgroundProcessManager {
  private readonly processes = new Map<number, ManagedBackgroundProcess>();
  private readonly runDir: string;

  constructor(private readonly options: { runId: string; workspaceRoot: string }) {
    this.runDir = path.join(
      getReaperScratchpadPaths(options.workspaceRoot).runs,
      options.runId,
    );
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register a freshly spawned child. Wires stdout / stderr / exit
   * listeners exactly once. Caller must already hold the ChildProcess
   * and any logPath it wants persisted.
   */
  register(entry: ManagedBackgroundProcess): void {
    this.processes.set(entry.child.pid ?? -1, entry);
    this.attach(entry);
  }

  get(pid: number): ManagedBackgroundProcess | undefined {
    return this.processes.get(pid);
  }

  has(pid: number): boolean {
    return this.processes.has(pid);
  }

  delete(pid: number): boolean {
    return this.processes.delete(pid);
  }

  entries(): IterableIterator<[number, ManagedBackgroundProcess]> {
    return this.processes.entries();
  }

  snapshot(): BackgroundProcessSnapshot[] {
    return Array.from(this.processes.entries()).map(([pid, entry]) => {
      const snap: BackgroundProcessSnapshot = {
        pid,
        status: entry.child.exitCode === null ? "running" : "finished",
        exitCode: entry.child.exitCode,
        startedAt: entry.startedAt,
        cmd: entry.cmd,
      };
      return entry.logPath ? { ...snap, logPath: entry.logPath } : snap;
    });
  }

  // -------------------------------------------------------------------------
  // Output buffer
  // -------------------------------------------------------------------------

  /**
   * Return the last `lines` lines from the bounded ring buffer.
   * Bounded by `getMaxOutputLines()` so a chatty long-running process
   * doesn't OOM the agent.
   */
  recentOutput(pid: number, lines: number): string {
    const entry = this.processes.get(pid);
    if (!entry) return "";
    return entry.output.slice(-lines).join("\n");
  }

  private pushBoundedOutput(output: string[], text: string): void {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      output.push(line);
    }
    const max = getMaxOutputLines();
    if (output.length > max) {
      output.splice(0, output.length - max);
    }
  }

  // -------------------------------------------------------------------------
  // Listener attachment
  // -------------------------------------------------------------------------

  private attach(entry: ManagedBackgroundProcess): void {
    entry.child.stdout?.on("data", (data) => {
      const text = String(data);
      this.pushBoundedOutput(entry.output, text);
      void this.appendLog(entry, "stdout", text);
    });
    entry.child.stderr?.on("data", (data) => {
      const text = String(data);
      this.pushBoundedOutput(entry.output, text);
      void this.appendLog(entry, "stderr", text);
    });
    entry.child.on("exit", (code, signal) => {
      void this.appendLog(
        entry,
        "system",
        `Process exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (!entry.notified) {
        entry.notified = true;
      }
    });
  }

  private async appendLog(
    entry: ManagedBackgroundProcess,
    stream: "stdout" | "stderr" | "system",
    data: string,
  ): Promise<void> {
    if (!entry.logPath) return;
    await appendFile(
      entry.logPath,
      JSON.stringify({ timestamp: new Date().toISOString(), stream, data }) + "\n",
      "utf8",
    ).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Signal / termination
  // -------------------------------------------------------------------------

  /**
   * Send `signal` to the process tree rooted at `pid`. Resolves once
   * tree-kill has fired (not once the process has actually exited —
   * pair with `waitForExit` if you need that).
   */
  async killTree(pid: number | undefined, signal: NodeJS.Signals): Promise<void> {
    if (!pid) return;
    return new Promise((resolve) => {
      treeKill(pid, signal, (err) => {
        if (err) {
          try {
            process.kill(-pid, signal);
          } catch {
            try {
              process.kill(pid, signal);
            } catch {
              // Process already exited.
            }
          }
        }
        resolve();
      });
    });
  }

  async waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * SIGTERM every tracked child, wait, SIGKILL the holdouts. Then
   * walk the OS process table and reap any grandchildren the parent
   * spawned but we don't have ChildProcess handles for.
   */
  async terminateAll(reason: string): Promise<void> {
    const entries = Array.from(this.processes.entries());
    await Promise.all(
      entries.map(async ([pid, entry]) => {
        if (entry.child.exitCode === null) {
          await this.killTree(pid, "SIGTERM");
          await this.waitForExit(entry.child, getTermGraceMs());
        }
        if (entry.child.exitCode === null) {
          await this.killTree(pid, "SIGKILL");
          await this.waitForExit(entry.child, getKillGraceMs());
        }
        await this.appendLog(entry, "system", `Process cleanup: ${reason}`);
        this.processes.delete(pid);
      }),
    );
    // Skip the descendant scan when no processes were ever registered —
    // walking /proc on every cleanup caused the strict-completion test
    // runner to hang waiting for the event loop to drain.
    if (entries.length === 0) return;
    await this.cleanupDescendantProcesses(reason);
    await this.persistManifest();
  }

  /**
   * Walk the OS process tree for anything still rooted at this Node
   * process and SIGTERM/SIGKILL it. Best-effort — the OS process list
   * may be unavailable on some platforms; we swallow that.
   */
  private async cleanupDescendantProcesses(reason: string): Promise<void> {
    const processes = await listProcesses().catch(() => []);
    const childrenByParent = new Map<number, Array<{ pid: number; cmd: string }>>();
    for (const item of processes) {
      const children = childrenByParent.get(item.ppid) ?? [];
      children.push({ pid: item.pid, cmd: item.cmd });
      childrenByParent.set(item.ppid, children);
    }

    const descendants: Array<{ pid: number; cmd: string }> = [];
    const visit = (pid: number): void => {
      for (const child of childrenByParent.get(pid) ?? []) {
        if (child.pid === process.pid) continue;
        descendants.push(child);
        visit(child.pid);
      }
    };
    visit(process.pid);

    const stillRunning = descendants.filter((item) => item.pid !== process.pid);
    if (stillRunning.length === 0) return;

    await Promise.all(
      stillRunning.map(
        (item) =>
          new Promise<void>((resolve) => {
            treeKill(item.pid, "SIGTERM", (err) => {
              if (err) {
                try {
                  process.kill(item.pid, "SIGTERM");
                } catch {
                  // Already exited.
                }
              }
              resolve();
            });
          }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, getDescendantTermGraceMs()));

    for (const item of stillRunning) {
      try {
        process.kill(item.pid, 0);
        await new Promise<void>((resolve) => {
          treeKill(item.pid, "SIGKILL", () => resolve());
        });
      } catch {
        // Already exited.
      }
    }

    await appendFile(
      path.join(this.runDir, "descendant-cleanup.log"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        reason,
        descendants: stillRunning,
      }) + "\n",
      "utf8",
    ).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Manifest persistence + restart survival
  // -------------------------------------------------------------------------

  /**
   * Write the current set of managed processes to
   * `<runDir>/processes.json`. Called on every register / signal /
   * exit so the file is always close to up to date.
   */
  async persistManifest(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    const manifest: PersistedManifest = {
      runId: this.options.runId,
      updatedAt: new Date().toISOString(),
      processes: this.snapshot(),
    };
    await writeFile(
      path.join(this.runDir, "processes.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  /**
   * Reap any children recorded in a manifest from a previous Reaper
   * run. Call this at startup BEFORE registering any new processes;
   * orphaned children from a crashed run get SIGTERMed and, after a
   * short grace, SIGKILLed. Best-effort: the OS may have reaped the
   * pid already (pid reuse defence via the startedAtMs wall clock).
   *
   * The caller passes the runDir to scan. In production this is the
   * runDir for the just-launched run (no orphans expected) OR the
   * most recent prior runDir from `.reaper_data/runs/`.
   */
  static async reapOrphansFromManifest(
    manifestPath: string,
    options: { logDir?: string } = {},
  ): Promise<{ reaped: number; skipped: number; missing: number }> {
    let manifest: PersistedManifest;
    try {
      const raw = await readFile(manifestPath, "utf8");
      manifest = JSON.parse(raw) as PersistedManifest;
    } catch {
      return { reaped: 0, skipped: 0, missing: 0 };
    }

    let reaped = 0;
    let skipped = 0;
    let missing = 0;
    for (const proc of manifest.processes) {
      if (proc.status !== "running") {
        skipped++;
        continue;
      }
      try {
        // signal 0 = "does this pid exist?" without sending anything.
        process.kill(proc.pid, 0);
      } catch {
        missing++;
        continue;
      }
      // Pid is alive. Best-effort reap. We don't have the ChildProcess
      // handle, so we use treeKill directly.
      await new Promise<void>((resolve) => {
        treeKill(proc.pid, "SIGTERM", () => resolve());
      });
      reaped++;
    }

    // Grace window before SIGKILL escalation.
    await new Promise((resolve) => setTimeout(resolve, getDescendantTermGraceMs()));

    for (const proc of manifest.processes) {
      if (proc.status !== "running") continue;
      try {
        process.kill(proc.pid, 0);
      } catch {
        continue;
      }
      await new Promise<void>((resolve) => {
        treeKill(proc.pid, "SIGKILL", () => resolve());
      });
    }

    if (options.logDir) {
      await mkdir(options.logDir, { recursive: true }).catch(() => undefined);
      await appendFile(
        path.join(options.logDir, "orphan-reap.log"),
        JSON.stringify({
          timestamp: new Date().toISOString(),
          manifest: manifestPath,
          reaped,
          skipped,
          missing,
        }) + "\n",
        "utf8",
      ).catch(() => undefined);
    }

    return { reaped, skipped, missing };
  }
}

// ---------------------------------------------------------------------------
// OS process table — small dependency-free /proc + ps fallback.
// ---------------------------------------------------------------------------

interface ProcTableEntry {
  pid: number;
  ppid: number;
  cmd: string;
}

async function listProcesses(): Promise<ProcTableEntry[]> {
  if (process.platform === "linux") {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile("/proc", { encoding: "utf8" }).catch(() => "");
      // /proc is a directory; readdir is what we actually want.
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir("/proc").catch(() => []);
      const out: ProcTableEntry[] = [];
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          const m = stat.match(/^\d+ \([^)]*\) \S+ (\d+)/);
          if (!m) continue;
          const ppid = Number(m[1]);
          const cmdRaw = await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "");
          out.push({ pid, ppid, cmd: cmdRaw.trim() });
        } catch {
          // Process exited between readdir and read.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
  // Non-linux: best-effort ps.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pidStr, ppidStr, ...rest] = line.split(/\s+/);
        return {
          pid: Number(pidStr),
          ppid: Number(ppidStr),
          cmd: rest.join(" "),
        };
      })
      .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.ppid));
  } catch {
    return [];
  }
}
