import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { readFile, writeFile, unlink } from "node:fs/promises";

import {
  cancelSubagentJob,
  completeSubagentJob,
  failSubagentJob,
  getSubagentJob,
  updateSubagentJobSnapshot,
  type SubagentJob,
  subagentJobs,
  type SubagentStatus,
} from "./subagent-state.js";

export interface SubagentPoolOptions {
  /**
   * Serialized Reaper config (already parsed/validated). Written to a temp
   * JSON file and passed to the worker via argv.
   */
  config: unknown;
  workspaceRoot: string;
  /**
   * Optional operational log directory for the worker config artifact. Defaults
   * to `<workspaceRoot>/.reaper`.
   */
  runDir?: string;
  /**
   * Optional override for the worker entry path. Used by tests to inject a
   * non-model fake worker.
   */
  workerPath?: string;
  /**
   * Arguments passed as `execArgv` to the worker child process. Defaults to
   * `['--import', 'tsx']` so that `.ts` worker files load correctly.
   */
  workerExecArgv?: string[];
}

export interface SubagentWorkerMessage {
  type: "complete" | "error";
  jobId: string | undefined;
  result?: unknown;
  error?: string;
}

/**
 * Holds references to in-flight background subagent worker processes. Each
 * worker runs in a separate Node process and uses the same model gateway as
 * the main runtime, but with the `*_subagent` role/source labels so telemetry
 * distinguishes subagent calls.
 *
 * The pool is deliberately lightweight: it does not queue jobs. Callers should
 * start jobs through the `call_subagent` tool and then poll/cancel them via
 * `poll_subagent`/`cancel_subagent`.
 */
export class SubagentPool {
  private readonly processByJob = new Map<string, ChildProcess>();
  private readonly configPath: string;
  private closed = false;

  constructor(private readonly options: SubagentPoolOptions) {
    const runDir = options.runDir ?? path.join(options.workspaceRoot, ".reaper");
    this.configPath = path.join(runDir, "subagent-worker-config.json");
  }

  static async create(options: SubagentPoolOptions): Promise<SubagentPool> {
    const pool = new SubagentPool(options);
    await writeFile(pool.configPath, JSON.stringify(options.config, null, 2), "utf8");
    return pool;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async run(job: SubagentJob): Promise<void> {
    if (this.closed) {
      failSubagentJob(job.id, "SubagentPool is closed");
      return;
    }

    const resolvedObserved = (job.observedFiles ?? []).map((file) =>
      path.isAbsolute(file) ? file : path.resolve(this.options.workspaceRoot, file),
    );
    const baseSnapshot = await computeFileSnapshot(resolvedObserved);
    updateSubagentJobSnapshot(job.id, {
      observedFiles: resolvedObserved,
      baseFilesSnapshot: baseSnapshot,
    });

    const workerPath = this.options.workerPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "subagent-worker.ts");
    const child = fork(workerPath, [this.configPath, job.id], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, REAPER_SUBAGENT_WORKER: "1" },
      execArgv: this.options.workerExecArgv ?? ["--import", "tsx"],
    });
    this.processByJob.set(job.id, child);

    child.stdout?.on("data", (chunk) => {
      // best-effort debugging; ignore in production
      void chunk;
    });
    child.stderr?.on("data", (chunk) => {
      void chunk;
    });

    child.on("message", (message: SubagentWorkerMessage) => {
      if (message.jobId !== job.id) return;
      if (message.type === "complete") {
        completeSubagentJob(message.jobId, message.result);
      } else if (message.type === "error") {
        failSubagentJob(message.jobId, message.error ?? "worker error");
      }
      this.remove(message.jobId);
    });

    child.on("error", (error) => {
      failSubagentJob(job.id, error.message);
      this.remove(job.id);
    });

    child.on("exit", (code) => {
      const current = subagentJobs.get(job.id);
      if (current && current.status === "running") {
        failSubagentJob(job.id, `worker exited with code ${code ?? "unknown"}`);
      }
      this.remove(job.id);
    });

    child.send({ job: getSubagentJob(job.id) ?? job, configPath: this.configPath, workspaceRoot: this.options.workspaceRoot });
  }

  cancel(jobId: string, reason = "cancelled by user/runtime"): void {
    const child = this.processByJob.get(jobId);
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    cancelSubagentJob(jobId, reason);
    this.remove(jobId);
  }

  flushCompleted(): SubagentJob[] {
    const jobs: SubagentJob[] = [];
    for (const [, job] of subagentJobs) {
      if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
        jobs.push(job);
      }
    }
    return jobs;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [jobId, child] of this.processByJob) {
      if (!child.killed) child.kill("SIGKILL");
      this.remove(jobId);
    }
    await unlink(this.configPath).catch(() => undefined);
  }

  private remove(jobId: string): void {
    this.processByJob.delete(jobId);
  }
}

async function computeFileSnapshot(filePaths: string[]): Promise<string> {
  const hash = crypto.createHash("sha256");
  const sorted = [...filePaths].sort();
  for (const filePath of sorted) {
    try {
      const content = await readFile(filePath);
      hash.update(content);
    } catch {
      hash.update(`__missing__${filePath}`);
    }
  }
  if (sorted.length === 0) {
    hash.update("__empty__");
  }
  return hash.digest("hex");
}
