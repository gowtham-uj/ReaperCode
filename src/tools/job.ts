/**
 * tools/job.ts — job facade over background work.
 *
 * A single tool wrapping the read/signal/write operations that are otherwise
 * spread across `read_background_output`, `signal_process`, and
 * `write_to_process`. Jobs are identified by the OS pid of the spawned child,
 * which is what `BackgroundProcessManager` keys on and what `bash` returns when
 * it backgrounds a command.
 *
 * This tool does not spawn processes — only `bash` does. See the `start` action
 * for the redirect.
 */

import { z } from "zod";

import type { BackgroundProcessManager } from "./background-process-manager.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const JobArgsSchema = z
  .object({
    action: z
      .enum(["start", "list", "poll", "cancel", "write"])
      .describe(
        "Action: list (all jobs), poll (read output), cancel (send signal), write (to stdin). 'start' is not supported — use bash with run_in_background instead.",
      ),
    command: z.string().optional().describe("Unused. Present only so 'start' can report a useful error."),
    jobId: z
      .string()
      .optional()
      .describe("Job ID for poll/cancel/write actions. This is the OS pid returned when bash backgrounds a command."),
    signal: z
      .enum(["SIGINT", "SIGTERM", "SIGKILL"])
      .optional()
      .describe("Signal for 'cancel' action (default SIGTERM)."),
    input: z.string().optional().describe("Text to write to stdin for 'write' action."),
    lines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of trailing output lines to return for 'poll' (default 100)."),
    description: z.string().optional().describe("Unused. Present only so 'start' can report a useful error."),
    timeout: z.number().int().positive().optional().describe("Unused. Present only so 'start' can report a useful error."),
  })
  .strict();

export type JobArgs = z.infer<typeof JobArgsSchema>;

export interface JobResult {
  action: string;
  jobId?: string;
  status?: string;
  exitCode?: number | null;
  logPath?: string;
  output?: string;
  jobs?: Array<{ jobId: string; command: string; status: string; exitCode: number | null; pid: number }>;
  error?: string;
}

const DEFAULT_POLL_LINES = 100;

/**
 * Job ids are pids rendered as strings. Reject anything else rather than
 * letting `Number()` coerce it to NaN and silently miss in the process map.
 */
function parseJobId(jobId: string): number | undefined {
  if (!/^\d+$/.test(jobId.trim())) return undefined;
  const pid = Number(jobId.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function executeJob(
  args: JobArgs,
  options: { workspaceRoot: string; runId: string; processManager?: BackgroundProcessManager },
): Promise<JobResult> {
  const manager = options.processManager;
  if (!manager) {
    return { action: args.action, error: "No process manager available" };
  }

  // Every action except `list` and `start` needs to resolve a live process.
  let pid: number | undefined;
  if (args.action === "poll" || args.action === "cancel" || args.action === "write") {
    if (!args.jobId) {
      return { action: args.action, error: `jobId is required for ${args.action} action` };
    }
    pid = parseJobId(args.jobId);
    if (pid === undefined) {
      return {
        action: args.action,
        jobId: args.jobId,
        error: `Invalid jobId "${args.jobId}": expected a numeric process id.`,
      };
    }
    if (!manager.has(pid)) {
      return { action: args.action, jobId: args.jobId, error: `No background process found with PID ${pid}` };
    }
  }

  switch (args.action) {
    case "list": {
      return {
        action: "list",
        jobs: manager.snapshot().map((p) => ({
          jobId: String(p.pid),
          pid: p.pid,
          command: p.cmd,
          status: p.status,
          exitCode: p.exitCode,
        })),
      };
    }

    case "poll": {
      const entry = manager.get(pid!)!;
      return {
        action: "poll",
        jobId: String(pid),
        status: entry.child.exitCode === null ? "running" : "finished",
        exitCode: entry.child.exitCode,
        ...(entry.logPath ? { logPath: entry.logPath } : {}),
        output: manager.recentOutput(pid!, args.lines ?? DEFAULT_POLL_LINES),
      };
    }

    case "cancel": {
      const entry = manager.get(pid!)!;
      const signal = args.signal ?? "SIGTERM";
      await manager.killTree(pid!, signal);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        await manager.waitForExit(entry.child, signal === "SIGTERM" ? 1500 : 500);
        if (entry.child.exitCode !== null || signal === "SIGKILL") {
          manager.delete(pid!);
        }
      }
      await manager.persistManifest().catch(() => undefined);
      return {
        action: "cancel",
        jobId: String(pid),
        status: entry.child.exitCode === null ? "signalled" : "finished",
        exitCode: entry.child.exitCode,
      };
    }

    case "write": {
      if (args.input === undefined) {
        return { action: "write", jobId: String(pid), error: "input is required for write action" };
      }
      const entry = manager.get(pid!)!;
      if (!entry.child.stdin || entry.child.stdin.destroyed) {
        return {
          action: "write",
          jobId: String(pid),
          error: `Process with PID ${pid} does not have an open stdin.`,
        };
      }
      entry.child.stdin.write(args.input);
      return { action: "write", jobId: String(pid), status: "written" };
    }

    case "start": {
      return {
        action: "start",
        error:
          "job cannot start processes. Use the bash tool with run_in_background: true — it returns a pid, which is the jobId for job's poll/cancel/write actions.",
      };
    }

    default: {
      const exhaustive: never = args.action;
      return { action: String(exhaustive), error: `Unknown action: ${String(exhaustive)}` };
    }
  }
}
