import type { ModelGateway, ModelRole } from "../model/types.js";
import { buildSubagentPrompt, buildSubagentSystemPrompt } from "../runtime/subagent-prompts.js";
import {
  completeSubagentJob,
  createSubagentJob,
  failSubagentJob,
  type SubagentType,
} from "../runtime/subagent-state.js";
import type { CallSubagentArgs, ToolResult } from "./types.js";

export interface ExecuteSubagentToolDeps {
  modelGateway: ModelGateway;
  toolCallId: string;
}

const SUBAGENT_SOURCE: Record<SubagentType, string> = {
  planner: "planner_subagent",
  reviewer: "reviewer_subagent",
  repair: "repair_subagent",
  tester: "tester_subagent",
  researcher: "researcher_subagent",
};

export async function executeSubagentTool(
  args: CallSubagentArgs,
  deps: ExecuteSubagentToolDeps,
): Promise<ToolResult> {
  const started = Date.now();
  const job = createSubagentJob({
    type: args.type,
    task: args.task,
    ...(args.context !== undefined ? { context: args.context } : {}),
    mode: args.mode ?? "blocking",
  });

  if (args.mode === "background") {
    const message = "call_subagent background mode is accepted by the schema but is not implemented in Part 11; use mode:'blocking'.";
    failSubagentJob(job.id, message);
    return failedResult(deps.toolCallId, args, started, "unsupported_subagent_mode", message);
  }

  try {
    const response = await withOptionalTimeout(
      deps.modelGateway.generate({
        role: roleForSubagent(args.type),
        source: SUBAGENT_SOURCE[args.type],
        system: buildSubagentSystemPrompt(args.type),
        messages: [{ role: "user", content: buildSubagentPrompt(args.type, args.task, args.context) }],
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
  args: CallSubagentArgs,
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
    error: { code, message },
  };
}
