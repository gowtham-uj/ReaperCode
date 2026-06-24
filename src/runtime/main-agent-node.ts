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
  const toolCalls = parseMainAgentToolCalls(response);
  const validation = validateToolCallBatch(toolCalls, { agentRole: "main" });

  return {
    source: "main_agent",
    response,
    assistantMessage: parseAssistantMessage(response),
    toolCalls,
    feedback: validation.ok ? [] : buildMainAgentBehaviorFeedback(validation.blockers),
    validationBlockers: validation.blockers,
  };
}

export function parseMainAgentToolCalls(response: GenerateResult | unknown): ToolCall[] {
  const rawToolCalls = extractRawToolCalls(response);
  if (!rawToolCalls) return [];
  if (!Array.isArray(rawToolCalls)) {
    throw new Error("main_agent response tool_calls must be an array when present.");
  }

  const parsed: ToolCall[] = [];
  const errors: string[] = [];
  for (let index = 0; index < rawToolCalls.length; index += 1) {
    const normalized = normalizeToolCallInput(rawToolCalls[index]);
    const result = ToolCallSchema.safeParse(normalized);
    if (result.success) {
      parsed.push(result.data);
    } else {
      errors.push(`tool_calls[${index}]: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`main_agent response contained invalid tool calls. ${errors.join(" | ")}`);
  }
  return parsed.slice(0, 32);
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
  const args = record.args ?? record.arguments ?? record.input ?? record.parameters ?? {};
  const id = typeof record.id === "string" && record.id.trim() ? record.id : stableToolCallId(record.name, args);
  const { arguments: _arguments, input: _input, parameters: _parameters, ...withoutLegacyArguments } = record;
  return {
    ...withoutLegacyArguments,
    id,
    args,
  };
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
