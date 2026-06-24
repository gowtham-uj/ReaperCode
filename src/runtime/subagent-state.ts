import { randomUUID } from "node:crypto";

export type SubagentType = "planner" | "reviewer" | "repair" | "tester" | "researcher";
export type SubagentMode = "blocking" | "background";
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentJob {
  id: string;
  type: SubagentType;
  task: string;
  context?: string;
  mode: SubagentMode;
  status: SubagentStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export const subagentJobs = new Map<string, SubagentJob>();

export function createSubagentJob(input: {
  type: SubagentType;
  task: string;
  context?: string;
  mode?: SubagentMode;
}): SubagentJob {
  const now = new Date().toISOString();
  const job: SubagentJob = {
    id: `subagent-${randomUUID()}`,
    type: input.type,
    task: input.task,
    mode: input.mode ?? "blocking",
    status: "running",
    createdAt: now,
    updatedAt: now,
    ...(input.context !== undefined ? { context: input.context } : {}),
  };
  subagentJobs.set(job.id, job);
  return job;
}

export function completeSubagentJob(jobId: string, result: unknown): SubagentJob {
  return updateSubagentJob(jobId, { status: "completed", result });
}

export function failSubagentJob(jobId: string, error: string): SubagentJob {
  return updateSubagentJob(jobId, { status: "failed", error });
}

export function cancelSubagentJob(jobId: string, reason = "cancelled"): SubagentJob {
  return updateSubagentJob(jobId, { status: "cancelled", error: reason });
}

function updateSubagentJob(
  jobId: string,
  patch: Pick<SubagentJob, "status"> & Partial<Pick<SubagentJob, "result" | "error">>,
): SubagentJob {
  const current = subagentJobs.get(jobId);
  if (!current) throw new Error(`Unknown subagent job '${jobId}'`);
  const now = new Date().toISOString();
  const next: SubagentJob = {
    ...current,
    ...patch,
    updatedAt: now,
    completedAt: now,
  };
  subagentJobs.set(jobId, next);
  return next;
}
