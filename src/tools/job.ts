/**
 * tools/job.ts — Phase 5: job facade over background work.
 *
 * Unifies async bash (isBackground), read_background_output, signal_process,
 * and write_to_process into a single tool with list/poll/cancel operations.
 * Keeps existing process tools for backward compatibility.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const JobArgsSchema = z
  .object({
    action: z
      .enum(["start", "list", "poll", "cancel", "write"])
      .describe("Action: start (background command), list (all jobs), poll (read output), cancel (send signal), write (to stdin)."),
    command: z
      .string()
      .optional()
      .describe("Shell command for 'start' action."),
    jobId: z
      .string()
      .optional()
      .describe("Job ID for poll/cancel/write actions."),
    signal: z
      .enum(["SIGINT", "SIGTERM", "SIGKILL"])
      .optional()
      .describe("Signal for 'cancel' action (default SIGTERM)."),
    input: z
      .string()
      .optional()
      .describe("Text to write to stdin for 'write' action."),
    description: z
      .string()
      .optional()
      .describe("Description for the 'start' action."),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in seconds for the 'start' action."),
  })
  .strict();

export type JobArgs = z.infer<typeof JobArgsSchema>;

export interface JobResult {
  action: string;
  jobId?: string;
  status?: string;
  output?: string;
  jobs?: Array<{ jobId: string; command: string; status: string; pid?: number }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Execute a job action.
 *
 * This is a thin facade over the existing background process manager.
 * The actual process management is handled by the existing BackgroundProcessManager.
 */
export async function executeJob(
  args: JobArgs,
  options: { workspaceRoot: string; runId: string; processManager?: any },
): Promise<JobResult> {
  switch (args.action) {
    case "list": {
      if (!options.processManager) {
        return { action: "list", jobs: [], error: "No process manager available" };
      }
      const processes = options.processManager.getBackgroundProcesses?.() ?? [];
      return {
        action: "list",
        jobs: processes.map((p: any) => ({
          jobId: p.id ?? p.sessionId ?? "unknown",
          command: p.command ?? p.cmd ?? "",
          status: p.status ?? p.state ?? "unknown",
          pid: p.pid,
        })),
      };
    }

    case "poll": {
      if (!args.jobId) return { action: "poll", error: "jobId is required for poll action" };
      if (!options.processManager) {
        return { action: "poll", jobId: args.jobId, error: "No process manager available" };
      }
      const output = options.processManager.readBackgroundOutput?.(args.jobId) ?? "";
      const status = options.processManager.getProcessStatus?.(args.jobId) ?? "unknown";
      return {
        action: "poll",
        jobId: args.jobId,
        status,
        output: typeof output === "string" ? output.slice(-4000) : JSON.stringify(output).slice(-4000),
      };
    }

    case "cancel": {
      if (!args.jobId) return { action: "cancel", error: "jobId is required for cancel action" };
      if (!options.processManager) {
        return { action: "cancel", jobId: args.jobId, error: "No process manager available" };
      }
      const sig = args.signal ?? "SIGTERM";
      await options.processManager.signalProcess?.(args.jobId, sig);
      return { action: "cancel", jobId: args.jobId, status: "cancelled" };
    }

    case "write": {
      if (!args.jobId) return { action: "write", error: "jobId is required for write action" };
      if (!args.input) return { action: "write", error: "input is required for write action" };
      if (!options.processManager) {
        return { action: "write", jobId: args.jobId, error: "No process manager available" };
      }
      await options.processManager.writeToProcess?.(args.jobId, args.input);
      return { action: "write", jobId: args.jobId, status: "written" };
    }

    case "start": {
      if (!args.command) return { action: "start", error: "command is required for start action" };
      if (!options.processManager) {
        return { action: "start", error: "No process manager available" };
      }
      const jobId = await options.processManager.startBackgroundProcess?.({
        command: args.command,
        description: args.description ?? "",
        cwd: options.workspaceRoot,
        timeout: args.timeout,
      });
      return {
        action: "start",
        jobId: typeof jobId === "string" ? jobId : String(jobId ?? "unknown"),
        status: "running",
      };
    }

    default:
      return { action: args.action, error: `Unknown action: ${args.action}` };
  }
}
