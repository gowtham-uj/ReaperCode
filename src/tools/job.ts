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
import { processHasExited } from "./background-process-manager.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/*
 * `start` is deliberately in the enum even though it is not supported.
 *
 * An audit flagged it as a surplus entry, and the reasoning is worth writing
 * down because the alternative is worse. Removing `start` would make a model
 * that calls `job({action:"start"})` — which a model reaching for "run a
 * background job" plausibly does — hit a schema violation ("action: Invalid
 * enum value"), a message about the tool's shape rather than about the right
 * way to do the thing. Keeping it means the handler runs and answers with the
 * redirect: start a process with `bash` and `run_in_background`, then manage it
 * here. The entry exists to produce that sentence, not to do work.
 */
export const JobArgsSchema = z
  .object({
    action: z
      .enum(["start", "list", "poll", "cancel", "write"])
      .describe(
        "Action: list (all jobs), poll (read output), cancel (send signal), write (to stdin). 'start' is accepted only to explain that it is unsupported — use bash with run_in_background: true to start a job.",
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
  /** Set by `cancel`: the signal that was delivered, so the caller knows the job was asked to stop. */
  cancelledBy?: string;
  /** A one-line explanation of the result, when the outcome needs one. */
  note?: string;
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
        status: processHasExited(entry.child) ? "finished" : "running",
        exitCode: entry.child.exitCode,
        ...(entry.logPath ? { logPath: entry.logPath } : {}),
        output: manager.recentOutput(pid!, args.lines ?? DEFAULT_POLL_LINES),
      };
    }

    case "cancel": {
      const entry = manager.get(pid!)!;
      const signal = args.signal ?? "SIGTERM";
      await manager.killTree(pid!, signal);
      /*
       * Wait for the process to actually die before reporting.
       *
       * `status: "signalled"` meant "we sent a signal", which is not what a
       * caller asking to cancel wants to know — and on SIGKILL the record was
       * deleted in the same breath, so a follow-up `poll` could not tell the
       * caller the process had ended either. The status now reflects the real
       * end state: `finished` when the process is gone, `signalled` only when it
       * is somehow still alive after the signal (which surfaces as a process
       * that ignored a signal it should not have).
       *
       * A SIGKILL is delivered immediately and cannot be caught, so a short
       * grace is enough to reap it; the generous grace is reserved for SIGTERM,
       * which a well-behaved process handles before exiting.
       */
      await manager.waitForExit(entry.child, signal === "SIGTERM" ? 1500 : 500);
      const exited = processHasExited(entry.child);
      if (exited) {
        manager.delete(pid!);
      }
      await manager.persistManifest().catch(() => undefined);
      /*
       * `cancelledBy` names the signal, and that is the field that makes the
       * outcome readable.
       *
       * The audit's complaint was fair: a cancel returned `{status:"finished",
       * exitCode:null}`, which reads as "it finished on its own", and a follow-up
       * `poll` then said "No background process found" with no explanation. The
       * job was cancelled, and nothing in the result said so. `exitCode` is
       * null for a signalled process (Node sets `signalCode`, not `exitCode`),
       * so the absence of an exit code is exactly the cancellation signature —
       * naming the signal turns that into a statement rather than a puzzle. A
       * follow-up poll finding nothing is correct: a finished job is removed
       * from the map so a recycled pid cannot masquerade as the old one.
       */
      return {
        action: "cancel",
        jobId: String(pid),
        status: exited ? "finished" : "signalled",
        ...(exited ? { cancelledBy: signal } : {}),
        exitCode: entry.child.exitCode,
        /*
         * The wording matches what a poll actually says.
         *
         * The note promised a later poll "will report it as unknown" while the
         * poll answers "No background process found with PID …". A note that
         * describes a different message than the one the model will see sends
         * it looking for a status value that does not exist. The promise is kept
         * in spirit and now in words: the job is gone, and a poll says so.
         */
        ...(exited
          ? { note: `Cancelled with ${signal}; the job is gone, and a later poll for this pid will say no background process was found.` }
          : { note: `Sent ${signal} but the process is still alive. Try signal: "SIGKILL".` }),
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
