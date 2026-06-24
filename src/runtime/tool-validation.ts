import {
  getToolKind,
  isCompletionTool,
  isMutatingTool,
  type ToolKind,
} from "./tool-taxonomy.js";

export type ToolCallLike = {
  name: string;
  args?: unknown;
  arguments?: unknown;
};

export type ToolValidationBlockerCode =
  | "tool_calls_not_array"
  | "empty_tool_call_batch"
  | "invalid_tool_call_shape"
  | "unknown_tool"
  | "complete_task_batched_with_mutation"
  | "subagent_result_payload_not_tool_calls"
  | "tool_schema_error";

export type ToolValidationBlocker = {
  code: ToolValidationBlockerCode;
  message: string;
  index?: number;
  toolName?: string;
  kind?: ToolKind;
  details?: string[];
};

export type ToolValidationResult = {
  ok: boolean;
  blockers: ToolValidationBlocker[];
};

export type ToolSchemaValidationResult =
  | { ok: true }
  | { ok: false; details: string[] };

export type ToolValidationOptions = {
  allowUnknownTools?: boolean;
  agentRole?: "main" | "subagent";
  source?: "explicit_tool_calls" | "subagent_result";
  validateSchema?: (call: ToolCallLike, index: number) => ToolSchemaValidationResult;
};

export function validateToolCallBatch(toolCalls: unknown, options: ToolValidationOptions = {}): ToolValidationResult {
  const blockers: ToolValidationBlocker[] = [];

  if (options.source === "subagent_result") {
    blockers.push({
      code: "subagent_result_payload_not_tool_calls",
      message: "Subagent result payloads are not tool call batches and must not be parsed as tool calls.",
    });
    return { ok: false, blockers };
  }

  if (!Array.isArray(toolCalls)) {
    blockers.push({
      code: "tool_calls_not_array",
      message: "Tool calls must be provided as an explicit array.",
    });
    return { ok: false, blockers };
  }

  if ((options.agentRole ?? "main") === "main" && toolCalls.length === 0) {
    blockers.push({
      code: "empty_tool_call_batch",
      message: "Main agent execute_tools requires at least one tool call.",
    });
  }

  const normalized = toolCalls.map((call, index) => normalizeToolCallLike(call, index, blockers));
  for (const [index, call] of normalized.entries()) {
    if (!call) continue;
    const kind = getToolKind(call.name);
    if (kind === "unknown" && options.allowUnknownTools !== true) {
      blockers.push({
        code: "unknown_tool",
        message: `Unknown tool '${call.name}' is not allowed in this batch.`,
        index,
        toolName: call.name,
        kind,
      });
    }

    const schemaResult = options.validateSchema?.(call, index);
    if (schemaResult && !schemaResult.ok) {
      blockers.push({
        code: "tool_schema_error",
        message: `Tool schema validation failed for '${call.name}'.`,
        index,
        toolName: call.name,
        kind,
        details: schemaResult.details,
      });
    }
  }

  const hasCompletion = normalized.some((call) => call && isCompletionTool(call.name));
  if (hasCompletion) {
    const mutatingTool = normalized.find((call) => call && !isCompletionTool(call.name) && isMutatingTool(call.name));
    if (mutatingTool) {
      blockers.push({
        code: "complete_task_batched_with_mutation",
        message: `complete_task cannot be batched with mutating tool '${mutatingTool.name}'.`,
        toolName: mutatingTool.name,
        kind: getToolKind(mutatingTool.name),
      });
    }
  }

  return { ok: blockers.length === 0, blockers };
}

function normalizeToolCallLike(
  value: unknown,
  index: number,
  blockers: ToolValidationBlocker[],
): ToolCallLike | undefined {
  if (!value || typeof value !== "object") {
    blockers.push({
      code: "invalid_tool_call_shape",
      message: "Tool call must be an object with a non-empty string name.",
      index,
    });
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    blockers.push({
      code: "invalid_tool_call_shape",
      message: "Tool call must include a non-empty string name.",
      index,
    });
    return undefined;
  }

  return {
    name: raw.name,
    ...(Object.prototype.hasOwnProperty.call(raw, "args") ? { args: raw.args } : {}),
    ...(Object.prototype.hasOwnProperty.call(raw, "arguments") ? { arguments: raw.arguments } : {}),
  };
}
