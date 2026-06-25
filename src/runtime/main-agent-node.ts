import type { GenerateResult, ModelGateway, ModelRole } from "../model/types.js";
import { ToolCallSchema, type ToolCall } from "../tools/types.js";
import { validateToolCallBatch, type ToolValidationBlocker } from "./tool-validation.js";

export interface MainAgentCallInput {
  modelGateway: ModelGateway;
  role?: ModelRole;
  system: string;
  cockpit: string;
  tools?: unknown[];
  maxTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface MainAgentCallResult {
  source: "main_agent";
  response: GenerateResult;
  assistantMessage: string;
  toolCalls: ToolCall[];
  feedback: string[];
  validationBlockers: ToolValidationBlocker[];
}

export async function callMainAgent(input: MainAgentCallInput): Promise<MainAgentCallResult> {
  const response = await input.modelGateway.generate({
    role: input.role ?? "main_reasoner",
    source: "main_agent",
    system: input.system,
    messages: [{ role: "user", content: input.cockpit }],
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.tools ? {} : { responseFormat: "json" }),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  });
  if (response.finishReason === "length") {
    const validation = validateToolCallBatch([], { agentRole: "main" });
    return {
      source: "main_agent",
      response,
      assistantMessage: parseAssistantMessage(response),
      toolCalls: [],
      feedback: [
        "The main_agent response reached maxTokens and was rejected before parsing to avoid executing a partial tool batch.",
        ...buildMainAgentBehaviorFeedback(validation.blockers),
      ],
      validationBlockers: validation.blockers,
    };
  }
  const { calls, parseErrors } = parseMainAgentToolCallsDetailed(response);
  const validation = validateToolCallBatch(calls, { agentRole: "main" });
  const behaviorFeedback = buildMainAgentBehaviorFeedback(validation.blockers);
  const parseFeedback = buildToolCallParseErrorsFeedback(parseErrors);

  return {
    source: "main_agent",
    response,
    assistantMessage: parseAssistantMessage(response),
    toolCalls: calls,
    feedback: [...behaviorFeedback, ...parseFeedback],
    validationBlockers: validation.blockers,
  };
}

export function parseMainAgentToolCalls(response: GenerateResult | unknown): ToolCall[] {
  return parseMainAgentToolCallsDetailed(response).calls;
}

/**
 * Codex/Claude-style self-repair: separate valid tool calls from parse
 * errors so the agent can keep the valid calls and feed the errors back
 * as feedback for the next turn. The previous behavior was to throw on
 * any parse error, which forced the model to retry the entire batch.
 */
export function parseMainAgentToolCallsDetailed(
  response: GenerateResult | unknown,
): { calls: ToolCall[]; parseErrors: string[] } {
  const rawToolCalls = extractRawToolCalls(response);
  if (!rawToolCalls) return { calls: [], parseErrors: [] };
  if (!Array.isArray(rawToolCalls)) {
    return {
      calls: [],
      parseErrors: ["main_agent response tool_calls must be an array when present."],
    };
  }

  const calls: ToolCall[] = [];
  const parseErrors: string[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const normalized = normalizeToolCallInput(rawToolCalls[index]);
    const result = ToolCallSchema.safeParse(normalized);
    if (result.success) {
      calls.push(result.data);
    } else {
      parseErrors.push(
        `tool_calls[${index}]: ${result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
  }

  return { calls: calls.slice(0, 32), parseErrors };
}

export function buildMainAgentBehaviorFeedback(blockers: ToolValidationBlocker[]): string[] {
  if (blockers.length === 0) return [];
  return blockers.map((blocker) => {
    if (blocker.code === "empty_tool_call_batch") {
      return "The main_agent response did not include tool calls. Continue with concrete tools, or call complete_task only with strict completion evidence.";
    }
    return blocker.message;
  });
}

export function buildToolCallParseErrorsFeedback(parseErrors: string[]): string[] {
  if (parseErrors.length === 0) return [];
  return [
    "Some tool calls in your last response were malformed and were dropped. Fix and resend ONLY the malformed ones in your next turn:",
    ...parseErrors.map((err) => `- ${err}`),
  ];
}

function extractRawToolCalls(response: GenerateResult | unknown): unknown {
  const record = asRecord(response);
  if (!record) return undefined;
  if (record.toolCalls !== undefined) return record.toolCalls;

  const raw = asRecord(record.raw);
  if (raw?.tool_calls !== undefined) return raw.tool_calls;
  if (raw?.toolCalls !== undefined) return raw.toolCalls;

  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return undefined;
  const parsed = parseJsonObject(content);
  return parsed?.tool_calls ?? parsed?.toolCalls;
}

function parseAssistantMessage(response: GenerateResult): string {
  const raw = asRecord(response.raw);
  if (typeof raw?.assistant_message === "string") return raw.assistant_message;
  if (typeof raw?.assistantMessage === "string") return raw.assistantMessage;
  const parsed = parseJsonObject(response.content);
  if (typeof parsed?.assistant_message === "string") return parsed.assistant_message;
  if (typeof parsed?.assistantMessage === "string") return parsed.assistantMessage;
  return "";
}

function parseJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function normalizeToolCallInput(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  // Unwrap the OpenAI wire format: `{ type: "function", function: { name, arguments: "..." } }`.
  // The inner `function` object carries the canonical `name` and a JSON-string `arguments`.
  const inner = asRecord(record.function);
  const nameSource = (typeof record.name === "string" && record.name) || (inner && typeof inner.name === "string" ? inner.name : undefined);
  const argsSource = record.args
    ?? record.arguments
    ?? record.input
    ?? record.parameters
    ?? (inner ? (inner.arguments ?? inner.input ?? inner.parameters) : undefined);
  const args = parseArgsValue(argsSource);
  const id = typeof record.id === "string" && record.id.trim()
    ? record.id
    : stableToolCallId(nameSource, args);
  // Strip OpenAI wire-format keys that aren't part of the strict ToolCallSchema.
  const { arguments: _arguments, input: _input, parameters: _parameters, type: _type, function: _function, ...rest } = record;
  return {
    ...rest,
    id,
    ...(nameSource ? { name: nameSource } : {}),
    args,
  };
}

function parseArgsValue(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stableToolCallId(name: unknown, args: unknown): string {
  const base = `${typeof name === "string" && name ? name : "tool"}:${JSON.stringify(args)}`;
  let hash = 2166136261;
  for (let index = 0; index < base.length; index += 1) {
    hash ^= base.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `main-agent-${(hash >>> 0).toString(16)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
