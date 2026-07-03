import type {ModelGateway, ModelRole} from "../model/types.js";
import {SubagentPool} from "../runtime/subagent-pool.js";
import {buildSubagentPrompt, buildSubagentSystemPrompt} from "../runtime/subagent-prompts.js";
import {
  completeSubagentJob,
  createSubagentJob,
  failSubagentJob,
  getSubagentJob,
  cancelSubagentJob,
  type SubagentType,
} from "../runtime/subagent-state.js";
import type {ToolResult} from "./types.js";

export interface ExecuteSubagentToolDeps {
  modelGateway: ModelGateway;
  toolCallId: string;
  pool: SubagentPool | undefined;
}

const SUBAGENT_SOURCE: Record<string, string> = {
  planner: "planner_subagent",
  reviewer: "reviewer_subagent",
  repair: "repair_subagent",
  tester: "tester_subagent",
  researcher: "researcher_subagent",
};

export async function executeSubagentTool(
  args: any,
  deps: ExecuteSubagentToolDeps,
): Promise<ToolResult> {
  const started = Date.now();
  const job = createSubagentJob({
    type: args.type,
    task: args.task,
    ...(args.context !== undefined ? {context: args.context} : {}),
    mode: args.mode ?? "blocking",
  });

  if (args.mode === "background") {
    if (!deps.pool) {
      const message = "call_subagent background mode requires a SubagentPool, but none was configured.";
      failSubagentJob(job.id, message);
      return failedResult(deps.toolCallId, args, started, "missing_subagent_pool", message);
    }
    deps.pool.run(job);
    return {
      toolCallId: deps.toolCallId,
      name: "call_subagent",
      ok: true,
      durationMs: Date.now() - started,
      args,
      output: {
        status: "started",
        jobId: job.id,
        type: args.type,
        advisory: true,
        note: "Background subagent started. Use poll_subagent to check status.",
      },
    };
  }

  try {
    const response = await withOptionalTimeout(
      deps.modelGateway.generate({
        role: roleForSubagent(args.type),
        source: SUBAGENT_SOURCE[args.type] ?? "subagent",
        system: buildSubagentSystemPrompt(args.type),
        messages: [{role: "user", content: buildSubagentPrompt(args.type, args.task, args.context)}],
        responseFormat: "json",
      }),
      args.timeoutMs,
      `call_subagent ${args.type}`,
    );
    const parsed = parseStrictJson(response.content);
    completeSubagentJob(job.id, parsed);
    return {
      toolCallId: deps.toolCallId,
      name: "call_subagent",
      ok: true,
      durationMs: Date.now() - started,
      args,
      output: {
        status: "completed",
        jobId: job.id,
        type: args.type,
        advisory: true,
        result: parsed,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failSubagentJob(job.id, message);
    return failedResult(deps.toolCallId, args, started, "subagent_failed", message);
  }
}

export function executePollSubagentTool(args: any, toolCallId: string): ToolResult {
  const started = Date.now();
  const job = getSubagentJob(args.jobId);
  if (!job) {
    return failedResult(toolCallId, args, started, "subagent_not_found", `No subagent job found for '${args.jobId}'.`);
  }
  return {
    toolCallId,
    name: "poll_subagent",
    ok: true,
    durationMs: Date.now() - started,
    args,
    output: {
      status: job.status,
      jobId: job.id,
      type: job.type,
      advisory: true,
      result: job.result,
      error: job.error,
    },
  };
}

export function executeCancelSubagentTool(args: any, deps: {toolCallId: string; pool: SubagentPool | undefined}): ToolResult {
  const started = Date.now();
  const job = getSubagentJob(args.jobId);
  if (!job) {
    return failedResult(deps.toolCallId, args, started, "subagent_not_found", `No subagent job found for '${args.jobId}'.`);
  }
  if (deps.pool) {
    deps.pool.cancel(args.jobId, args.reason);
  } else {
    cancelSubagentJob(args.jobId, args.reason);
  }
  return {
    toolCallId: deps.toolCallId,
    name: "cancel_subagent",
    ok: true,
    durationMs: Date.now() - started,
    args,
    output: {
      status: getSubagentJob(args.jobId)?.status ?? "cancelled",
      jobId: args.jobId,
      advisory: true,
    },
  };
}

function roleForSubagent(type: SubagentType): ModelRole {
  return type === "planner" ? "planner" : "main_reasoner";
}

function parseStrictJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Subagent returned invalid JSON: ${message}`);
  }
}

async function withOptionalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!timeoutMs) return promise;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failedResult(
  toolCallId: string,
  args: unknown,
  started: number,
  code: string,
  message: string,
): ToolResult {
  return {
    toolCallId,
    name: "call_subagent",
    ok: false,
    durationMs: Date.now() - started,
    args,
    error: {code, message},
  };
}
