import {randomUUID} from "node:crypto";

export type SubagentType = "planner" | "reviewer" | "repair" | "tester" | "researcher";
export type SubagentMode = "blocking" | "background";
export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentJob {
  id: string;
  type: SubagentType;
  task: string;
  context?: string | undefined;
  mode: SubagentMode;
  status: SubagentStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  result: unknown | undefined;
  error: string | undefined;
  /** Process id of the worker handling this job, when background mode is used. */
  workerPid?: number | undefined;
  /** Whether this completed background job has already been injected into the main agent. */
  injected?: boolean | undefined;
  /** Hexdigest-or-otherwise snapshot of relevant files at the time the job started. Used for staleness checks. */
  baseFilesSnapshot?: string | undefined;
  /** Files the subagent claimed to observe. Staleness check focuses on these paths. */
  observedFiles?: string[] | undefined;
}

export const subagentJobs = new Map<string, SubagentJob>();

export function createSubagentJob(input: {
  type: SubagentType;
  task: string;
  context?: string | undefined;
  mode?: SubagentMode | undefined;
  workerPid?: number | undefined;
  baseFilesSnapshot?: string | undefined;
  observedFiles?: string[] | undefined;
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
    context: input.context,
    workerPid: input.workerPid,
    baseFilesSnapshot: input.baseFilesSnapshot,
    observedFiles: input.observedFiles,
    result: undefined,
    error: undefined,
  };
  subagentJobs.set(job.id, job);
  return job;
}

export function completeSubagentJob(jobId: string, result: unknown | undefined): SubagentJob {
  return updateSubagentJob(jobId, {status: "completed", result});
}

export function failSubagentJob(jobId: string, error: string): SubagentJob {
  return updateSubagentJob(jobId, {status: "failed", error});
}

export function cancelSubagentJob(jobId: string, reason = "cancelled"): SubagentJob {
  return updateSubagentJob(jobId, {status: "cancelled", error: reason});
}

export function updateSubagentJobSnapshot(
  jobId: string,
  updates: Partial<Pick<SubagentJob, "baseFilesSnapshot" | "observedFiles">>,
): SubagentJob {
  const current = subagentJobs.get(jobId);
  if (!current) throw new Error(`Unknown subagent job '${jobId}'`);
  const next: SubagentJob = { ...current, ...updates, updatedAt: new Date().toISOString() };
  subagentJobs.set(jobId, next);
  return next;
}

export function getSubagentJob(jobId: string): SubagentJob | undefined {
  return subagentJobs.get(jobId);
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
    status: patch.status,
    result: patch.result,
    error: patch.error,
    updatedAt: now,
    completedAt: now,
  };
  subagentJobs.set(jobId, next);
  return next;
}
