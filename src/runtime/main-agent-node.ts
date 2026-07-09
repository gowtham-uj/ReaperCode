import type { GenerateRequest, GenerateResult, ModelGateway, ModelRole, TokenUsage } from "../model/types.js";
import { normalizeToolCall } from "../tools/normalize.js";
import { ToolCallSchema, type ToolCall } from "../tools/types.js";
import { dim } from "./session-printer.js";
import { validateToolCallBatch, type ToolValidationBlocker } from "./tool-validation.js";
import { getEngineTunables } from "../config/config-tunables.js";


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
  const request: GenerateRequest = {
    role: input.role ?? "secondary_model",
    source: "main_agent",
    system: input.system,
    messages: [{ role: "user", content: input.cockpit }],
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.tools ? {} : { responseFormat: "json" as const }),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
  };
  const response = input.tools && input.tools.length > 0
    ? await streamMainAgentResponse(input.modelGateway, request)
    : await input.modelGateway.generate(request);
  if (getEngineTunables().swarmDebug) {
    console.error("[REAPER_DEBUG_MAIN_AGENT] SYSTEM:\n", input.system.slice(0, 4000));
    console.error("[REAPER_DEBUG_MAIN_AGENT] COCKPIT:\n", input.cockpit.slice(0, 4000));
    console.error("[REAPER_DEBUG_MAIN_AGENT] TOOLS:\n", JSON.stringify(input.tools?.map((t: any) => t.name), null, 2));
    console.error("[REAPER_DEBUG_MAIN_AGENT] RESPONSE content:", response.content.slice(0, 2000));
    console.error("[REAPER_DEBUG_MAIN_AGENT] RESPONSE toolCalls:", JSON.stringify(response.toolCalls));
  }
  // Reasoning and content are already streamed to stdout live during
  // streamMainAgentResponse — no need to print them again here.
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
  const assistantMessage = parseAssistantMessage(response);
  const validation = calls.length === 0 && isFinalAssistantSummary(assistantMessage)
    ? { ok: true as const, blockers: [] }
    : validateToolCallBatch(calls, { agentRole: "main" });
  const behaviorFeedback = buildMainAgentBehaviorFeedback(validation.blockers);
  const parseFeedback = buildToolCallParseErrorsFeedback(parseErrors);

  return {
    source: "main_agent",
    response,
    assistantMessage,
    toolCalls: calls,
    feedback: [...behaviorFeedback, ...parseFeedback],
    validationBlockers: validation.blockers,
  };
}

export async function streamMainAgentResponse(
  modelGateway: ModelGateway,
  request: GenerateRequest,
): Promise<GenerateResult> {
  const role = request.role;
  let provider = "stream";
  let model = "stream";
  let content = "";
  let reasoningContent = "";
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;
  const accumulatedToolCalls: ToolCall[] = [];
  const droppedToolCalls: Array<{ id: string; name?: string; error: string }> = [];
  // Buffered raw tool-call accumulators keyed by either their index in a
  // single response, or by OpenAI's per-call id. The provider may emit
  // deltas with no id (some compat gateways) so we synthesise one.
  const rawBuffer = new Map<string, { name?: string; argsText: string; sourceIndex: number }>();
  let nextSourceIndex = 0;
  let rawOrder: string[] = [];

  for await (const event of modelGateway.stream(request)) {
    if (event.type === "message_start") {
      const data = asRecord(event.data);
      if (typeof data?.provider === "string") provider = data.provider;
      if (typeof data?.model === "string") model = data.model;
      continue;
    }
    if (event.type === "message_delta") {
      if (typeof event.content === "string") {
        content += event.content;
        // Live stream actual model output to stdout immediately — no buffering
        process.stdout.write(event.content);
      }
      const data = asRecord(event.data);
      if (typeof data?.reasoningContent === "string") {
        reasoningContent += data.reasoningContent;
        // Live stream reasoning as dimmed "thinking" text
        process.stdout.write(dim(data.reasoningContent, process.stdout as NodeJS.WriteStream));
      }
      continue;
    }
    if (event.type === "reasoning_delta") {
      if (typeof event.content === "string") {
        reasoningContent += event.content;
        process.stdout.write(dim(event.content, process.stdout as NodeJS.WriteStream));
      }
      continue;
    }
    if (event.type === "tool_call") {
      // Either a complete call (single-shot) or a delta assembly block.
      // Reference-loop style: just accumulate per-call and let `message_end`
      // finalize the assistant's tool calls. No JSON-parse fire-and-forget
      // here — the partial args may be incomplete chunks (e.g., "{ " when
      // the arguments stream is broken across many small deltas).
      const data = asRecord(event.data);
      if (!data) continue;
      // Resolve the call index/id.
      const idCandidate = typeof data.id === "string" && data.id.trim()
        ? data.id
        : `idx-${nextSourceIndex}`;
      // Resolve accumulated state.
      let buf = rawBuffer.get(idCandidate);
      if (!buf) {
        buf = { argsText: "", sourceIndex: nextSourceIndex++ };
        rawBuffer.set(idCandidate, buf);
        rawOrder.push(idCandidate);
      }
      if (typeof data.name === "string" && data.name) buf.name = data.name;
      const argDelta = asRecord(data.function);
      const argText = argDelta && typeof argDelta.arguments === "string"
        ? argDelta.arguments
        : typeof data.arguments === "string"
          ? data.arguments
          : undefined;
      if (typeof argText === "string") buf.argsText += argText;
      else if (data.args && typeof data.args === "object") {
        // Already-parsed args: replace buffered text with JSON form.
        try { buf.argsText = JSON.stringify(data.args); } catch { /* ignore */ }
      }
      continue;
    }
    if (event.type === "message_end") {
      // reference-style finalization: parse every buffered tool call and put it
      // on `accumulatedToolCalls` for the caller. Tools execute AFTER the
      // stream returns (the engine runs them sequentially, matching
      // the reference loop's `executeToolCalls` ordering) so the conversation shape is
      // [user, assistant.tool_calls, tool, tool, ..., user] — never
      // the reverse order that Reaper's old callback produced.
      for (const id of rawOrder) {
        const buf = rawBuffer.get(id);
        if (!buf || !buf.name) continue;
        const idFinal = id.startsWith("idx-") ? "" : id;
        const normalized = normalizeToolCall({
          ...(idFinal ? { id: idFinal } : {}),
          name: buf.name,
          function: { name: buf.name, arguments: buf.argsText },
        });
        const validated = ToolCallSchema.safeParse(normalized);
        if (!validated.success) {
          // Never silently drop: the model will retry forever thinking the
          // tool never ran (seen with scratchpad when normalize wiped args).
          const issueSummary = validated.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
          droppedToolCalls.push({
            id: idFinal || id,
            name: buf.name,
            error: issueSummary,
          });
          if (getEngineTunables().swarmDebug) {
            console.error(
              `[REAPER_DEBUG_MAIN_AGENT] dropped tool_call name=${buf.name} id=${idFinal || id}: ${issueSummary}`,
            );
          }
          continue;
        }
        if (accumulatedToolCalls.some((c) => c.id === validated.data.id)) continue;
        accumulatedToolCalls.push(validated.data);
      }
      const data = asRecord(event.data);
      if (typeof data?.finishReason === "string") finishReason = data.finishReason;
      const rawUsage = asRecord(data?.usage);
      if (rawUsage) {
        const prompt = typeof rawUsage.promptTokens === "number" ? rawUsage.promptTokens : typeof rawUsage.inputTokens === "number" ? rawUsage.inputTokens : 0;
        const completion = typeof rawUsage.completionTokens === "number" ? rawUsage.completionTokens : typeof rawUsage.outputTokens === "number" ? rawUsage.outputTokens : 0;
        usage = { inputTokens: prompt, outputTokens: completion };
      }
      continue;
    }
    if (event.type === "error") {
      const data = asRecord(event.data);
      throw new Error(typeof data?.message === "string" ? data.message : "main agent stream failed");
    }
  }

  return {
    role,
    profileName: role,
    provider,
    model,
    content,
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(accumulatedToolCalls.length ? { toolCalls: accumulatedToolCalls } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
    raw: {
      streamed: true,
      toolCalls: accumulatedToolCalls,
      finishReason,
      ...(droppedToolCalls.length ? { droppedToolCalls } : {}),
    },
  };
}

export function parseMainAgentToolCalls(response: GenerateResult | unknown): ToolCall[] {
  return parseMainAgentToolCallsDetailed(response).calls;
}

/**
 * Self-repair: separate valid tool calls from parse
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
    const normalized = normalizeToolCall(normalizeToolCallInput(rawToolCalls[index]));
    const result = ToolCallSchema.safeParse(normalized);
    if (result.success) {
      calls.push(result.data);
    } else {
      parseErrors.push(
        `tool_calls[${index}]: ${result.error.issues
          .map((issue) => `${issue.path.join("")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
  }

  return { calls: calls.slice(0, 32), parseErrors };
}

export function isFinalAssistantSummary(message: string): boolean {
  const visible = stripThinkingBlocks(message).replace(/\s+/g, " ").trim();
  if (!visible) return false;

  // Textual tool-call markup is never a final summary — the model still
  // intends to act, even if the provider failed to emit structured tools.
  if (containsEmbeddedToolCallMarkup(message)) return false;

  const actionIntent = /\b(?:i(?:'|’)ll|i will|i am going to|i'm going to|let me|i need to|i should|i'll now|i will now|next,? i(?:'|’)ll|now i(?:'|’)ll|i can proceed|let's)\b/i.test(visible);
  const weakCompletion = /\b(?:done|complete|completed|implemented|created|updated|fixed|verified)\b/i.test(visible);
  const strongCompletion = /\b(?:tests? pass(?:ed|es)?|all checks pass(?:ed)?|npm test pass(?:ed)?|verification pass(?:ed)?|task (?:is )?complete|all (?:required )?(?:files|deliverables) (?:are )?(?:done|complete)|status:\s*success)\b/i.test(visible);
  const futureAction = /\b(?:will|going to|need to|should|next|proceed|create|writ(?:e|ing)|run(?:ning)?|check(?:ing)?|inspect(?:ing)?|verif(?:y|ying)|append(?:ing)?)\b/i.test(visible);
  // Mid-batch announcements like "Writing f10-f14 now." / "creating the next batch".
  const midBatchAnnounce = /\b(?:writing|creating|editing|appending|continuing)\b.{0,100}\b(?:now|next|then|batch|remaining|rest)\b/i.test(visible);

  if (midBatchAnnounce && !strongCompletion) return false;
  if (actionIntent && !strongCompletion) return false;
  if (futureAction && !strongCompletion) return false;
  if (!weakCompletion && !strongCompletion) return false;
  return strongCompletion || (weakCompletion && !futureAction && !midBatchAnnounce && !actionIntent);
}

/**
 * True when assistant text contains tool-call markup that is NOT a
 * structured OpenAI-compatible tool_calls payload (e.g. `<tool_call>{...}</tool_call>`).
 * Used only to reject such turns as final summaries / trigger a nudge —
 * never to invent executable tool calls from text.
 */
export function containsEmbeddedToolCallMarkup(message: string): boolean {
  if (!message) return false;
  if (/<\s*tool_call\b/i.test(message)) return true;
  if (/<\/\s*tool_call\s*>/i.test(message)) return true;
  if (/\{\\*"name\\*"\s*:\s*\\*"[a-zA-Z_][\w-]*\\*"\s*,\s*\\*"(?:parameters|arguments|args)\\*"\s*:/i.test(message)) {
    return true;
  }
  return false;
}

function stripThinkingBlocks(message: string): string {
  return message.replace(/<think>[\s\S]*?<\/think>/gi, " ");
}

export function buildMainAgentBehaviorFeedback(blockers: ToolValidationBlocker[]): string[] {
  if (blockers.length === 0) return [];
  return blockers.map((blocker) => {
    if (blocker.code === "empty_tool_call_batch") {
      return "The main_agent response did not include tool calls or a final assistant summary. If the task is done, provide a concise final assistant_message with no tool_calls; otherwise continue with concrete tools.";
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
  if (typeof raw?.assistant_message === "string") return raw.assistant_message.trim();
  if (typeof raw?.assistantMessage === "string") return raw.assistantMessage.trim();
  const parsed = parseJsonObject(response.content);
  if (typeof parsed?.assistant_message === "string") return parsed.assistant_message.trim();
  if (typeof parsed?.assistantMessage === "string") return parsed.assistantMessage.trim();

  // Blank-canvas runtime: the model may return free-form text instead of
  // the requested JSON object. Treat that text as a terminal assistant
  // summary unless it looks like a pure JSON tool_call payload.
  const content = response.content?.trim() ?? "";
  if (!content) return "";
  if (parsed && (parsed.tool_calls || parsed.toolCalls) && Object.keys(parsed).length === 1) {
    return "";
  }
  return content;
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
