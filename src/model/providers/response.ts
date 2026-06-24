/**
 * Typed provider response parsing.
 *
 * Replaces per-provider `as any` casts on `response.json()` with a
 * single zod-validated parse layer. Each provider family (Anthropic
 * Messages, OpenAI Chat) has its own raw shape; downstream
 * `ProviderModelClient.generate` consumers always see the same
 * normalized `GenerateResult`.
 *
 * This module does not introduce new behavior — it only narrows the
 * runtime shapes we already parse correctly by hand. If a provider
 * starts returning a new field, the type system surfaces the
 * regression instead of silently dropping it.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export const AnthropicContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.unknown()).default({}),
  }),
]);

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  content: z.array(AnthropicContentBlockSchema).default([]),
  stop_reason: z.string().nullish(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
});

export type AnthropicMessagesResponse = z.infer<typeof AnthropicMessagesResponseSchema>;

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (and OpenAI-compatible: Cerebras, DeepSeek,
// OpenRouter, LiteLLM-gateway)
// ---------------------------------------------------------------------------

const OpenAIToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").optional(),
  function: z
    .object({
      name: z.string(),
      arguments: z.string().optional(),
    })
    .optional(),
  // Some OpenAI-compatible providers emit tool calls with `name` and `input`
  // directly on the block instead of nested under `function`.
  name: z.string().optional(),
  input: z.unknown().optional(),
});

export const OpenAIChatChoiceSchema = z.object({
  index: z.number().optional(),
  message: z.object({
    role: z.literal("assistant").default("assistant"),
    content: z.string().nullish(),
    reasoning: z.string().nullish(),
    reasoning_content: z.string().nullish(),
    tool_calls: z.array(OpenAIToolCallSchema).optional(),
  }),
  finish_reason: z.string().nullish(),
});

export const OpenAIChatResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(OpenAIChatChoiceSchema).min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export type OpenAIChatResponse = z.infer<typeof OpenAIChatResponseSchema>;

// ---------------------------------------------------------------------------
// OpenAI Embeddings (used by LiteLLM gateway)
// ---------------------------------------------------------------------------

export const OpenAIEmbeddingsResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()).optional(),
      index: z.number().optional(),
    }),
  ),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export type OpenAIEmbeddingsResponse = z.infer<typeof OpenAIEmbeddingsResponseSchema>;

// ---------------------------------------------------------------------------
// Helper: parse tool-call arguments that may be a JSON string or an object.
// ---------------------------------------------------------------------------

export function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Helper: extract a TokenUsage from any of the parsed response shapes.
// Kept here so each provider client gets the same normalize logic.
// Returns undefined when no usage envelope is present.
// ---------------------------------------------------------------------------

export interface ExtractedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function extractUsage(
  response:
    | {
        usage?:
          | {
              input_tokens?: number | undefined;
              output_tokens?: number | undefined;
              prompt_tokens?: number | undefined;
              completion_tokens?: number | undefined;
              cache_creation_input_tokens?: number | undefined;
              cache_read_input_tokens?: number | undefined;
              [extra: string]: unknown;
            }
          | undefined;
      }
    | null
    | undefined,
): ExtractedTokenUsage | undefined {
  if (!response || !response.usage) return undefined;
  const u = response.usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  const input = isFiniteNumber(u.input_tokens)
    ? u.input_tokens
    : isFiniteNumber(u.prompt_tokens) ? u.prompt_tokens : undefined;
  const output = isFiniteNumber(u.output_tokens)
    ? u.output_tokens
    : isFiniteNumber(u.completion_tokens) ? u.completion_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  const out: ExtractedTokenUsage = { inputTokens: input ?? 0, outputTokens: output ?? 0 };
  if (isFiniteNumber(u.cache_read_input_tokens)) out.cacheReadTokens = u.cache_read_input_tokens;
  if (isFiniteNumber(u.cache_creation_input_tokens)) out.cacheWriteTokens = u.cache_creation_input_tokens;
  return out;
}
