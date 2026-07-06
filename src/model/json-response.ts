import { getLegacyModelRole, getModelProfileName, type GenerateResult, type ModelGateway, type ModelRole, type StreamEvent, type TokenUsage } from "./types.js";
import { jsonrepair } from "jsonrepair";
import {
  classifyStructuredResponseShape,
  getPreferredStructuredMode,
  recordStructuredResponseObservation,
  type StructuredResponseMode,
} from "./response-adapter.js";

import { enqueueLlmCall } from "./concurrency.js";
import { QueryGuard } from "../runtime/query-guard.js";
import type { Hooks } from "../adaptive/hooks.js";
import { recordModelCall } from "./observability.js";
import { getEngineTunables } from "../config/config-tunables.js";


const queryGuard = new QueryGuard();

/**
 * Pi-style streaming hook event. Emitted by `streamStructuredJson` for
 * each chunk the model produces so the TUI can render text as it
 * arrives instead of waiting for the full response.
 */
export type StreamDelta =
  | { kind: "message"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string }
  | { kind: "error"; message: string };

export type StreamDeltaSink = (delta: StreamDelta) => void | Promise<void>;

/**
 * Streaming variant of `generateStructuredJson`. It calls
 * `modelGateway.stream()` instead of `generate()` and pipes each
 * chunk through `onDelta` as it arrives so the TUI sees text appear
 * token-by-token. Once the stream ends, the buffered content is parsed
 * identically to `generateStructuredJsonInQueue` — same parser, same
 * retry loop, same fallback. The only difference is real-time liveness.
 *
 * Why this lives next to `generateStructuredJson` rather than inside
 * it: providers that don't yet emit true SSE (today: every Reaper
 * provider except those that wire raw HTTP/2) will still produce the
 * same buffered delta sequence. The parser doesn't care whether the
 * text arrived in one chunk or ten; it just needs the full content at
 * `message_end`. Wiring it through the streaming path also means
 * when a provider adds real SSE (Phase 6), the TUI gets true
 * per-token deltas with zero engine changes.
 */
export async function streamStructuredJson<T>(input: {
  modelGateway: ModelGateway;
  hooks?: Hooks;
  role: ModelRole;
  source?: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  parse: (value: unknown) => T;
  maxTokens?: number;
  isRetry?: boolean;
  truncationRetryCount?: number;
  onDelta?: StreamDeltaSink;
  /** Phase T2.7: callback invoked once per model call with the
   *  provider-reported token usage (best-effort — undefined when the
   *  provider didn't report any). The engine wires this to its
   *  TokenBudgetTracker so per-call usage feeds the per-turn
   *  snapshot written into the `token_budget` trajectory event. */
  onUsage?: (usage: TokenUsage | undefined) => void;
}): Promise<T> {
  const callStart = Date.now();
  return enqueueLlmCall(async () => {
    const gen = queryGuard.start();
    try {
      queryGuard.markRunning(gen);
      return await streamStructuredJsonInQueue(input);
    } finally {
      queryGuard.finish(gen);
    }
  }, {
    latencyFn: () => Date.now() - callStart,
  });
}

async function streamStructuredJsonInQueue<T>(input: {
  modelGateway: ModelGateway;
  hooks?: Hooks;
  role: ModelRole;
  source?: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  parse: (value: unknown) => T;
  maxTokens?: number;
  isRetry?: boolean;
  truncationRetryCount?: number;
  onDelta?: StreamDeltaSink;
  onUsage?: (usage: TokenUsage | undefined) => void;
}): Promise<T> {
  const profile = await input.modelGateway.resolveRole(input.role);
  const preferred = getPreferredStructuredMode(profile.provider, profile.model, input.role);
  const modes: StructuredResponseMode[] =
    preferred === "provider_json" ? ["provider_json", "text_json"] : ["text_json", "provider_json"];
  const errors: string[] = [];

  for (const mode of modes) {
    let buffer = "";
    let reasoningBuffer = "";
    let truncated = false;
    let finishReason: string | undefined;
    let lastError: string | undefined;

    try {
      const stream = input.modelGateway.stream({
        role: input.role,
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(mode === "provider_json" ? { responseFormat: "json" as const } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        messages: withJsonOnlyInstruction(input.messages, mode),
      });
      for await (const event of stream) {
        await consumeStreamEvent(event, {
          onMessage: async (chunk) => {
            buffer += chunk;
            // Pi-style: emit each chunk to the sink AND to the hooks bus
            // so the TUI can render text as it arrives.
            await safeSink(input.onDelta, { kind: "message", text: chunk });
            if (input.hooks) {
              try {
                await input.hooks.emit({
                  name: "AssistantMessageDelta",
                  payload: { text: chunk, role: "assistant", done: false },
                  blockable: false,
                });
              } catch {
                /* hook errors are fail-open */
              }
            }
          },
          onReasoning: async (chunk) => {
            reasoningBuffer += chunk;
            await safeSink(input.onDelta, { kind: "reasoning", text: chunk });
            if (input.hooks) {
              try {
                await input.hooks.emit({
                  name: "ReasoningDelta",
                  payload: { text: chunk, role: "assistant", done: false },
                  blockable: false,
                });
              } catch {
                /* fail-open */
              }
            }
          },
          onToolCall: async (name) => {
            await safeSink(input.onDelta, { kind: "tool_call", name });
          },
          onMessageEnd: async (data) => {
            const finish = (data as { finishReason?: string } | undefined)?.finishReason;
            if (typeof finish === "string") finishReason = finish;
            truncated = finishReason === "length";
            // Phase T2.7: pull usage out of the stream-end envelope
            // (Anthropic / Cerebras / OpenRouter / DeepSeek providers
            // attach `usage` to the message_end.data). Best-effort.
            if (input.onUsage) {
              try {
                const streamUsage = (data as { usage?: TokenUsage } | undefined)?.usage;
                input.onUsage(streamUsage);
              } catch {
                /* tracker bugs must not derail the model loop */
              }
            }
          },
          onError: async (message) => {
            lastError = message;
          },
        });
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }

    if (lastError) {
      errors.push(`${mode}: ${lastError}`);
      continue;
    }

    // Finalize the streaming hooks so the TUI's message bubble commits.
    if (input.hooks) {
      if (reasoningBuffer) {
        try {
          await input.hooks.emit({
            name: "ReasoningComplete",
            payload: { text: reasoningBuffer, role: "assistant", done: true },
            blockable: false,
          });
        } catch {
          /* fail-open */
        }
      }
      if (buffer) {
        try {
          await input.hooks.emit({
            name: "AssistantMessageComplete",
            payload: { text: buffer, role: "assistant", done: true },
            blockable: false,
          });
        } catch {
          /* fail-open */
        }
      }
    }

    const response = {
      role: input.role,
      profileName: profile.profileName,
      provider: profile.provider,
      model: profile.model,
      content: buffer,
      raw: { streamed: true, finishReason },
      ...(finishReason !== undefined ? { finishReason } : {}),
    } satisfies GenerateResult;

    if (response.finishReason === "length") {
      errors.push(
        `${mode}: response reached maxTokens and was rejected before parsing to avoid executing a partial structured tool batch.`,
      );
      continue;
    }

    const attempt = tryParse(input.parse, response);
    recordStructuredResponseObservation({
      result: response,
      mode,
      ok: attempt.ok,
      shape: classifyStructuredResponseShape(buffer),
    });

    if (!attempt.ok) {
      errors.push(`${mode}: ${attempt.error}`);
      continue;
    }
    return attempt.value;
  }

  // Streaming path failed for every mode — fall back to the
  // non-streaming generator (it has its own retry / truncation /
  // parser-feedback loop and may succeed where streaming didn't,
  // e.g. when the provider's stream() is broken but generate() works).
  return generateStructuredJsonInQueue({
    modelGateway: input.modelGateway,
    role: input.role,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: input.messages,
    parse: input.parse,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.isRetry ? { isRetry: true } : {}),
    ...(input.truncationRetryCount !== undefined
      ? { truncationRetryCount: input.truncationRetryCount }
      : {}),
  });
}

async function safeSink(sink: StreamDeltaSink | undefined, delta: StreamDelta): Promise<void> {
  if (!sink) return;
  try {
    await sink(delta);
  } catch {
    /* sink errors are fail-open */
  }
}

type StreamConsumers = {
  onMessage: (chunk: string) => Promise<void>;
  onReasoning: (chunk: string) => Promise<void>;
  onToolCall: (name: string) => Promise<void>;
  onMessageEnd: (data: unknown) => Promise<void>;
  onError: (message: string) => Promise<void>;
};

async function consumeStreamEvent(event: StreamEvent, consumers: StreamConsumers): Promise<void> {
  switch (event.type) {
    case "message_start":
      return;
    case "message_delta":
      if (typeof event.content === "string" && event.content) {
        await consumers.onMessage(event.content);
      }
      return;
    case "reasoning_delta":
      if (typeof event.content === "string" && event.content) {
        await consumers.onReasoning(event.content);
      }
      return;
    case "tool_call":
      if (event.data && typeof event.data === "object") {
        const name = String((event.data as { name?: string }).name ?? "unknown");
        await consumers.onToolCall(name);
      }
      return;
    case "message_end":
      await consumers.onMessageEnd(event.data);
      return;
    case "error": {
      const message = String((event.data as { message?: string } | undefined)?.message ?? "unknown error");
      await consumers.onError(message);
      return;
    }
    default:
      return;
  }
}
export async function generateStructuredJson<T>(input: {
  modelGateway: ModelGateway;
  hooks?: Hooks;
  role: ModelRole;
  source?: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  parse: (value: unknown) => T;
  maxTokens?: number;
  isRetry?: boolean;
  truncationRetryCount?: number;
  /** When true, the structured-call truncation retry storm is
   *  disabled for this call. Use for planner/replan calls where
   *  doubling the prompt or output budget does not help and just
   *  adds ~85s of latency per retry. The caller is expected to
   *  handle a returned parse failure as a replan signal instead. */
  disableTruncationRetry?: boolean;
  /** When true, a `finish_reason === "length"` on the primary mode
  *  causes the retry to use the secondary mode (text_json ↔ provider_json)
  *  instead of re-issuing the same mode with a larger maxTokens. Used
  *  for providers where one mode is fast and the other is slow, so the
  *  cross-mode retry is meaningfully cheaper. Mature agents (Codex,
  *  Claude Code) use this same pattern to recover from mid-stream
  *  truncation. */
  switchModeOnTruncation?: boolean;
  /** Phase T2.7: callback invoked once per model call with the
  *  provider-reported token usage. The engine wires this to its
  *  TokenBudgetTracker so per-call usage feeds the per-turn
  *  snapshot written into the `token_budget` trajectory event. */
  onUsage?: (usage: TokenUsage | undefined) => void;
  }): Promise<T> {
  const callStart = Date.now();
  return enqueueLlmCall(async () => {
    const gen = queryGuard.start();
    try {
      queryGuard.markRunning(gen);
      return await generateStructuredJsonInQueue(input);
    } finally {
      queryGuard.finish(gen);
    }
  }, {
    latencyFn: () => Date.now() - callStart,
  });
}

async function generateStructuredJsonInQueue<T>(input: {
  modelGateway: ModelGateway;
  hooks?: Hooks;
  role: ModelRole;
  source?: string;
  system?: string;
  messages: Array<{ role: string; content: string }>;
  parse: (value: unknown) => T;
  maxTokens?: number;
  isRetry?: boolean;
  truncationRetryCount?: number;
  disableTruncationRetry?: boolean;
  switchModeOnTruncation?: boolean;
  onUsage?: (usage: TokenUsage | undefined) => void;
}): Promise<T> {
  const profile = await input.modelGateway.resolveRole(input.role);
  const preferred = getPreferredStructuredMode(profile.provider, profile.model, input.role);
  const modes: StructuredResponseMode[] = preferred === "provider_json" ? ["provider_json", "text_json"] : ["text_json", "provider_json"];
  const errors: string[] = [];
  let wasTruncated = false;
  let wasEmptyTruncated = false;
  let sawNonTruncatedParseFailure = false;
  let truncatedMode: StructuredResponseMode | undefined;

  let attemptIndex = 0;
  for (const mode of modes) {
    const callStartedAt = new Date().toISOString();
    const callStartedHr = Date.now();
    const response = await withModelCallTimeout(
      input.modelGateway.generate({
        role: input.role,
        ...(input.system !== undefined ? { system: input.system } : {}),
        ...(mode === "provider_json" ? { responseFormat: "json" as const } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        messages: withJsonOnlyInstruction(input.messages, mode),
      }),
      profile.timeoutMs ?? defaultStructuredCallTimeoutMs(),
      `${profile.provider}/${profile.model}:${input.role}:${mode}`,
    );
    attemptIndex += 1;
    const callEndedAt = new Date().toISOString();
    const callDurationMs = Date.now() - callStartedHr;
    const promptChars = input.messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
    const legacyRole = getLegacyModelRole(input.role);
    await recordModelCall(
      {
        role: input.role,
        ...(input.source !== undefined ? { source: input.source } : {}),
        profile: getModelProfileName(input.role),
        ...(legacyRole !== undefined ? { legacyRole } : {}),
        provider: profile.provider,
        model: profile.model,
        maxTokens: input.maxTokens,
        responseFormat: mode === "provider_json" ? "json" : "text",
        startedAt: callStartedAt,
        endedAt: callEndedAt,
        durationMs: callDurationMs,
        promptChars,
        responseChars: response.content.length,
        responseContentChars: response.content.length,
        ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
        responseFinishReason: response.finishReason,
        truncated: response.finishReason === "length",
        attempt: attemptIndex,
        ...(input.system !== undefined ? { systemChars: input.system.length } : {}),
        ...(response.toolCalls !== undefined ? { toolCallCount: response.toolCalls.length } : {}),
        usage: response.usage
          ? {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
            }
          : null,
      },
      withJsonOnlyInstruction(input.messages, mode),
      {
        content: response.content,
        ...(response.finishReason !== undefined ? { finishReason: response.finishReason } : {}),
        ...(response.toolCalls !== undefined ? { toolCalls: response.toolCalls } : {}),
      },
    );
    // Phase T2.7: report per-call usage to the engine's tracker (if
    // wired). Best-effort — providers that don't surface usage get a
    // silent skip here.
    if (input.onUsage) {
      try {
        input.onUsage(response.usage);
      } catch {
        /* tracker bugs must not derail the model loop */
      }
    }
    if (response.finishReason === "length") {
      wasTruncated = true;
      truncatedMode = mode;
      if (!response.content.trim()) wasEmptyTruncated = true;
      errors.push(
        `${mode}: response reached maxTokens and was rejected before parsing to avoid executing a partial structured tool batch.`,
      );
      continue;
    }
    const attempt = tryParse(input.parse, response);
    recordStructuredResponseObservation({
      result: response,
      mode,
      ok: attempt.ok,
      shape: classifyStructuredResponseShape(response.content),
    });
    if (!attempt.ok) {
      let errorMsg = attempt.error;
      if (response.finishReason === "length") {
        errorMsg = `Response was truncated (reached maxTokens limit). Please split your tool calls across multiple turns or provide more concise implementation. ${errorMsg}`;
      }
      console.warn(`[json-response] Model '${profile.model}' failed ${mode} parse. FinishReason: ${response.finishReason}. Raw content preview: ${response.content.substring(0, 500)}`);
      sawNonTruncatedParseFailure = true;
      errors.push(`${mode}: ${errorMsg}`);
    } else {
      return attempt.value;
    }
  }

    if (!input.isRetry && sawNonTruncatedParseFailure) {
      console.warn(`[json-response] Model '${profile.model}' produced invalid structured JSON. Retrying once with parser feedback.`);
      return generateStructuredJsonInQueue({
        ...input,
        isRetry: true,
        messages: [
          ...input.messages,
          {
            role: "user",
            content: [
              "CRITICAL: Your previous response did not satisfy the required structured JSON schema.",
              "Return exactly one JSON object and nothing else.",
              "For Reaper executor responses use {\"assistant_message\":\"...\",\"tool_calls\":[]}.",
              "Each tool call must be a plain object with {\"id\":\"stable-id\",\"name\":\"tool_name\",\"args\":{...}}.",
              "Do not use OpenAI function wrapper objects, markdown fences, split argument objects, comments, or trailing commas.",
              `Parser errors: ${errors.join(" | ").slice(0, 2000)}`,
            ].join("\n"),
          },
        ],
      });
    }

    if (wasTruncated && !wasEmptyTruncated) {
      const base = input.maxTokens ?? 8192;
      const maxRetryTokens = profile.capabilities.maxOutputTokens ?? profile.defaultParams?.maxTokens ?? 8192;
      const doubled = Math.min(base * 2, maxRetryTokens);
      const truncationRetryCount = input.truncationRetryCount ?? 0;
      if (input.disableTruncationRetry) {
        console.warn(`[json-response] Model '${profile.model}' truncated at maxTokens=${base}; truncation retry is disabled for this call.`);
      } else if (input.switchModeOnTruncation && truncationRetryCount === 0) {
        // Codex/Claude-Code style: when the primary mode truncates, switch to
        // the secondary mode (text_json ↔ provider_json) before paying for
        // a doubled maxTokens retry. The other mode is usually faster and
        // can also recover because the parser path is different.
        const remaining = modes.slice(attemptIndex + 1);
        if (remaining.length > 0) {
          const switchedMode = remaining[0]!;
          const originalMode: StructuredResponseMode = truncatedMode ?? "provider_json";
          console.warn(
            `[json-response] Model '${profile.model}' truncated in ${originalMode} mode. Switching to ${switchedMode} mode for recovery.`,
          );
          return generateStructuredJsonInQueue({
            ...input,
            switchModeOnTruncation: false,
            truncationRetryCount: truncationRetryCount + 1,
            messages: [
              ...input.messages,
              {
                role: "user",
                content: [
                  `Your previous ${originalMode} response was truncated mid-stream. Return a much smaller valid JSON object now using the ${switchedMode} mode.`,
                  "Do not include long explanations, markdown, full logs, or unused code.",
                  "If a file implementation is large, do NOT emit the full file now. First return a small read/search or create the smallest compilable skeleton; continue implementation across later turns with small targeted edits.",
                ].join("\n"),
              },
            ],
          });
        }
      } else if (doubled <= base || truncationRetryCount >= 1) {
        console.warn(`[json-response] Model '${profile.model}' truncated at max cap ${maxRetryTokens}. Cannot increase further.`);
      } else {
        console.warn(`[json-response] Model '${profile.model}' truncated. Retrying with doubled maxTokens (${doubled})...`);
        return generateStructuredJsonInQueue({
          ...input,
          maxTokens: doubled,
          truncationRetryCount: truncationRetryCount + 1,
          messages: [
            ...input.messages,
            {
              role: "user",
              content: [
                "CRITICAL: Your previous structured JSON response was truncated.",
                "Return a much smaller valid JSON object now.",
                "For executor-style responses, return at most 2 tool_calls.",
                "Do not include long explanations, markdown, full logs, or unused code.",
                "If a file implementation is large, do NOT emit the full file now. First return a small read/search or create the smallest compilable skeleton; continue implementation across later turns with small targeted edits.",
                "For generated source files, prefer compact code over comprehensive code in one turn. A successful small implementation plus later edits is better than a truncated JSON response.",
              ].join("\n"),
            },
          ],
        });
      }
    }

    if (!input.isRetry) {
      console.warn(`[json-response] Model '${profile.model}' produced invalid structured JSON. Retrying once with parser feedback.`);
      return generateStructuredJsonInQueue({
        ...input,
        isRetry: true,
        messages: [
          ...input.messages,
          {
            role: "user",
            content: [
              "CRITICAL: Your previous response did not satisfy the required structured JSON schema.",
              "Return exactly one JSON object and nothing else.",
              "For Reaper executor responses use {\"assistant_message\":\"...\",\"tool_calls\":[]}.",
              "Each tool call must be a plain object with {\"id\":\"stable-id\",\"name\":\"tool_name\",\"args\":{...}}.",
              "Do not use OpenAI function wrapper objects, markdown fences, split argument objects, comments, or trailing commas.",
              `Parser errors: ${errors.join(" | ").slice(0, 2000)}`,
            ].join("\n"),
          },
        ],
      });
    }

    const fallback = tryParse(input.parse, {
      content: JSON.stringify({
        assistant_message:
          "The previous model response was truncated or invalid. Continue with a smaller batch of concrete tool calls, or emit the required completion/control signal if the task is done.",
        tool_calls: [],
      }),
    });
    if (fallback.ok) {
      return fallback.value;
    }

  throw new Error(`Model '${profile.model}' failed to produce valid structured JSON for role '${input.role}': ${errors.join(" | ")}`);
}

function defaultStructuredCallTimeoutMs(): number {
  const raw = Number(getEngineTunables().modelCallTimeoutMs ?? getEngineTunables().liveModelTimeoutMs ?? 300_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000;
}

async function withModelCallTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Model call timed out after ${timeoutMs}ms (${label})`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function withJsonOnlyInstruction(
  messages: Array<{ role: string; content: string }>,
  mode: StructuredResponseMode,
): Array<{ role: string; content: string }> {
  const next = [...messages];
  const last = next.at(-1);
  if (!last) {
    return next;
  }

  next[next.length - 1] = {
    ...last,
    content:
      mode === "text_json"
        ? `${last.content}\n\nCRITICAL: Return ONLY a valid JSON object starting with { and ending with }. No markdown fences. No explanation. No filler text. Pure JSON only.`
        : `${last.content}\n\nCRITICAL: Return ONLY valid JSON through the provider JSON response mode. No markdown fences. No explanation text. No conversational filler.`,
  };
  return next;
}

/**
 * Strip a MiniMax-style leading `<think>...</think>` (or `<reasoning>...</reasoning>`)
 * reasoning block from a model response so the downstream JSON extractor
 * does not get fooled by `{...}` segments inside the reasoning text.
 *
 * Rules (pinned by tests/unit/json-response.test.ts):
 *   - Plain JSON or plain text passes through unchanged.
 *   - A closed `<think>...</think>` block (single- or multi-line) is dropped.
 *     The opening tag is treated as the start of a reasoning block even if
 *     the inner content happens to contain a JSON-shaped object; the model's
 *     only output is returned as `""` in that case so the structured-JSON
 *     retry loop kicks in downstream.
 *   - A closed `<reasoning>...</reasoning>` block is dropped.
 *   - An UNTERMINATED leading `<think>` (model ran out of tokens mid-reasoning)
 *     has its opening tag stripped but any trailing prose is preserved so the
 *     JSON extractor can still find a JSON object after the reasoning start.
 *   - Leading whitespace before the tag is preserved.
 *   - Empty string returns empty string.
 */
export function stripLeadingReasoning(input: string): string {
  if (input === "") return "";

  // Closed <reasoning>...</reasoning> block.
  const reasoningMatch = input.match(/^(\s*)<reasoning>[\s\S]*?<\/reasoning>/);
  if (reasoningMatch) {
    return input.slice(reasoningMatch[0].length);
  }

  // Closed <think>...</think> block. The [\s\S]*? match lets the block
  // span multiple lines; we strip aggressively even if the inner content
  // contains a JSON-shaped object — the test pins this behavior so the
  // downstream retry loop kicks in when the model wraps its only output
  // in think tags.
  const closedThinkMatch = input.match(/^(\s*)<think>[\s\S]*?<\/think>/);
  if (closedThinkMatch) {
    return input.slice(closedThinkMatch[0].length);
  }

  // Unterminated leading <think>: the model ran out of tokens mid-reasoning.
  // We strip just the opening tag and any leading whitespace so downstream
  // `extractJsonObject` can find the JSON object embedded in the trailing
  // prose. The test asserts `!out.startsWith("<think>")`.
  const unterminatedThinkMatch = input.match(/^(\s*)<think>/);
  if (unterminatedThinkMatch) {
    return input.slice(unterminatedThinkMatch[0].length);
  }

  return input;
}

export function parseJsonValue(input: string): unknown {
  const trimmed = stripLeadingReasoning(input).trim();
  if (!trimmed) {
    throw new Error("Model returned empty content.");
  }

  const extracted = extractJsonObject(trimmed) ?? trimmed;
  const boundaryRepaired = repairMissingObjectBoundaries(extracted);
  const candidates = [
    extracted,
    boundaryRepaired,
    boundaryRepaired ? tryRepairJson(boundaryRepaired) : undefined,
    tryRepairJson(extracted),
    repairTruncatedJson(extracted),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);

  const seen = new Set<string>();
  let lastError: unknown;
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  const repairedTruncated = repairTruncatedJson(extracted);
  const repairedTruncatedJson = tryRepairJson(repairedTruncated);
  if (repairedTruncatedJson && !seen.has(repairedTruncatedJson)) {
    try {
      return JSON.parse(repairedTruncatedJson);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Model returned invalid JSON.");
}

function tryRepairJson(input: string): string | undefined {
  try {
    return jsonrepair(input);
  } catch {
    return undefined;
  }
}

function repairMissingObjectBoundaries(input: string): string | undefined {
  const repaired = input.replace(/}\s*,\s*"((?:id|name|args|tool_call_id|tool_name|function)"\s*:)/g, '} ,{"$1');
  return repaired === input ? undefined : repaired.replace(/}\s*,\s*\{/g, "},{");
}

/**
 * Repair JSON that was truncated mid-stream. Strategy:
 *   1. Walk the input, tracking string/escape/braces. Close truncated strings.
 *   2. Find the last "complete value boundary" — a `,` whose preceding value
 *      ended at the same brace depth (i.e. the value before the `,` is
 *      itself a complete JSON value).
 *   3. Drop everything after that boundary.
 *   4. Close any remaining open braces/brackets.
 */
export function repairTruncatedJson(input: string): string {
  // First pass: original brace-close logic + close truncated strings.
  let prefix = "";
  const stack: ("{" | "[")[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escape) {
      escape = false;
      prefix += char;
      continue;
    }
    if (char === "\\") {
      escape = true;
      prefix += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      prefix += char;
      continue;
    }
    if (inString) {
      prefix += char;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      prefix += char;
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) continue;
      stack.pop();
      prefix += char;
      continue;
    }
    prefix += char;
  }

  if (inString) {
    prefix += '"';
  }

  // If we're inside a value (brace stack non-empty), find the last "complete
  // array element" boundary and drop everything from there onward. A
  // complete array element is preceded by a `,` whose preceding value is a
  // complete object/array/scalar. To drop the partial element rather than
  // truncate inside it, look for the last `,` followed (after whitespace)
  // by `{` or `[` — that marks the start of the partial element we should
  // discard.
  if (stack.length > 0) {
    let lastElementStart = -1;
    let depth = 0;
    let str = false;
    let esc = false;
    for (let i = 0; i < prefix.length; i++) {
      const c = prefix[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { str = !str; continue; }
      if (str) continue;
      if (c === "{" || c === "[") {
        // After a `,`, the start of a new element.
        if (depth > 0) {
          let j = i - 1;
          while (j >= 0 && /\s/.test(prefix[j] ?? "")) j--;
          if (prefix[j] === ",") {
            lastElementStart = i;
          }
        }
        depth++;
        continue;
      }
      if (c === "}" || c === "]") {
        depth--;
        continue;
      }
    }
    if (lastElementStart > 0) {
      // Drop from the `,` before lastElementStart, not the `{` itself,
      // so we keep the comma structure of the array.
      let cut = lastElementStart;
      while (cut > 0 && /\s/.test(prefix[cut - 1] ?? "")) cut--;
      if (prefix[cut - 1] === ",") cut--;
      prefix = prefix.slice(0, cut);
      // Recompute stack from scratch.
      stack.length = 0;
      depth = 0;
      str = false;
      esc = false;
      for (const c of prefix) {
        if (esc) { esc = false; continue; }
        if (c === "\\") { esc = true; continue; }
        if (c === '"') { str = !str; continue; }
        if (str) continue;
        if (c === "{" || c === "[") { depth++; stack.push(c as "{" | "["); }
        else if (c === "}" || c === "]") { depth--; stack.pop(); }
      }
    }
  }

  // Close any remaining open braces/brackets.
  while (stack.length > 0) {
    const last = stack.pop();
    if (last === "{") prefix += "}";
    else if (last === "[") prefix += "]";
  }

  return prefix;
}

function tryParse<T>(
  parse: (value: unknown) => T,
  response: { content: string; toolCalls?: unknown[]; provider?: string; model?: string; role?: ModelRole },
): { ok: true; value: T } | { ok: false; error: string } {
  try {
    let rawValue = parseResponseValue(response);
    if (response.content.trim() && !extractJsonObject(response.content.trim()) && containsToolCalls(rawValue)) {
      throw new Error("Refusing to execute tool calls from an incomplete top-level JSON object.");
    }

    // Auto-unwrap nested response objects
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const rec = rawValue as Record<string, unknown>;
      const keys = Object.keys(rec);
      if (keys.length === 1 && ["response", "output", "result", "json"].includes(keys[0]!)) {
        const nested = rec[keys[0]!];
        if (nested && typeof nested === "object" && !Array.isArray(nested)) {
          rawValue = nested;
        }
      }
    }

    return { ok: true, value: parse(rawValue) };
  } catch (error) {
    const initialError = error instanceof Error ? error.message : String(error);
    const recovered = recoverCompleteToolCallEnvelope(response.content, response.toolCalls);
    if (recovered) {
      try {
        return { ok: true, value: parse(recovered) };
      } catch (recoveryError) {
        return {
          ok: false,
          error: `${initialError} | complete-tool-call recovery failed: ${
            recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
          }`,
        };
      }
    }
    return { ok: false, error: initialError };
  }
}

function containsToolCalls(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray((value as Record<string, unknown>).tool_calls) &&
      ((value as Record<string, unknown>).tool_calls as unknown[]).length > 0,
  );
}

/**
 * Recover only independently complete tool-call objects. This deliberately
 * refuses to close or invent partial command/write payloads.
 */
export function recoverCompleteToolCallEnvelope(content: string, nativeToolCalls?: unknown[]): Record<string, unknown> | undefined {
  if (nativeToolCalls?.length) {
    return { assistant_message: "", tool_calls: nativeToolCalls };
  }
  const toolCallsArrayStart = findToolCallsArrayStart(content);
  if (toolCallsArrayStart < 0) return undefined;
  const objectTexts = extractCompleteArrayObjects(content, toolCallsArrayStart);
  const toolCalls: unknown[] = [];
  for (const objectText of objectTexts) {
    try {
      toolCalls.push(JSON.parse(objectText));
    } catch {
      const repaired = tryRepairJson(objectText);
      if (!repaired) continue;
      try {
        toolCalls.push(JSON.parse(repaired));
      } catch {
        // A malformed individual call is never executed.
      }
    }
  }
  return toolCalls.length > 0 ? { assistant_message: "", tool_calls: toolCalls } : undefined;
}

function findToolCallsArrayStart(content: string): number {
  const match = /["']tool_calls["']\s*:\s*\[/i.exec(content);
  if (!match) return -1;
  return content.indexOf("[", match.index + match[0].lastIndexOf("["));
}

function extractCompleteArrayObjects(content: string, arrayStart: number): string[] {
  const objects: string[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;
  for (let index = arrayStart + 1; index < content.length; index += 1) {
    const char = content[index]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inString && char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"' || char === "'") {
      if (!inString) {
        inString = true;
        quote = char;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(content.slice(objectStart, index + 1));
        objectStart = -1;
      }
      continue;
    }
    if (char === "]" && depth === 0) break;
  }
  return objects;
}

function parseResponseValue(response: { content: string; toolCalls?: unknown[] }): unknown {
  if (response.content.trim()) {
    try {
      return parseJsonValue(response.content);
    } catch (error) {
      if (response.toolCalls && response.toolCalls.length > 0) {
        return { tool_calls: response.toolCalls };
      }
      throw error;
    }
  }
  if (response.toolCalls && response.toolCalls.length > 0) {
    return { tool_calls: response.toolCalls };
  }
  return parseJsonValue(response.content);
}

export function extractJsonObject(input: string): string | undefined {
  const stripped = stripThinkingBlocks(input);
  const start = stripped.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < stripped.length; index += 1) {
    const char = stripped[index]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return stripped.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

/**
 * Strip MiniMax/Mistral-style `` / `` wrapper blocks
 * that the model emits around structured JSON. The block
 * can span multiple lines; we remove the wrapper text
 * itself and any embedded text, keeping only the JSON
 * content outside the wrappers.
 */
export function stripThinkingBlocks(input: string): string {
  if (!input.includes("<think>") && !input.includes("<think>") && !input.includes("```")) {
    return input;
  }
  let out = input;
  // Strip <...> blocks (greedy across newlines, content included)
  out = out.replace(/<[A-Za-z][A-Za-z0-9_]*[^>]*>[\s\S]*?<\/[A-Za-z][A-Za-z0-9_]*>/g, "");
  // Strip self-closing <foo/> tags
  out = out.replace(/<[A-Za-z][A-Za-z0-9_]*[^>]*\/>/g, "");
  // Strip fenced code blocks (```...```) including the optional language tag
  out = out.replace(/```[a-zA-Z0-9_+\-]*\r?\n[\s\S]*?```/g, "");
  return out;
}
