/**
 * model/provider/catalog.ts — the data file that drives provider
 * resolution. Adding a new vendor = one entry here, no code
 * changes (unless the vendor uses `sdkFamily: "custom"`, in which
 * case you also drop a client module under `model/providers/`).
 *
 * Each entry is a `ProviderDescriptor` — see `types.ts` for the
 * full shape. Notes on the field choices:
 *
 *   - `baseUrl` is the API root; the family appends the path
 *     (`/v1/messages` for anthropic, `/chat/completions` for
 *     openai). Trailing slashes are tolerated.
 *   - `envVar` is the standard env var name. Resolution order at
 *     startup: env var → onboarding file → fallback to the
 *     `ANTHROPIC_AUTH_TOKEN` legacy alias for backward compat.
 *   - `models` is the catalogue surfaced in the TUI picker.
 *     `defaultModel` must be in this list.
 *   - `capabilities` are shared across all models in the catalogue
 *     today; per-model overrides land later.
 */

import type { ProviderDescriptor } from "./types.js";

export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  // ── Anthropic native (sdkFamily: anthropic-messages) ────────────
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    sdkFamily: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    envVar: "ANTHROPIC_API_KEY",
    keyHint: "Get a key at https://console.anthropic.com — uses the native /v1/messages API",
    defaultModel: "claude-opus-4-8",
    models: [
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 32_000,
    },
    supportsReasoning: true,
    authScheme: "x-api-key",
  },

  // ── OpenAI native (sdkFamily: openai-chat) ──────────────────────
  {
    id: "openai",
    label: "OpenAI",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.openai.com/v1",
    envVar: "OPENAI_API_KEY",
    keyHint: "Get a key at https://platform.openai.com/api-keys",
    defaultModel: "gpt-4.1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 16_384,
    },
    supportsReasoning: true,
    authScheme: "bearer",
  },

  // ── MiniMax (sdkFamily: openai-chat) ────────────────────────────
  {
    id: "minimax",
    label: "MiniMax (api.minimax.io)",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.minimax.io/v1",
    envVar: "MINIMAX_API_KEY",
    keyHint: "Get a key at https://api.minimax.io — works with OpenAI-compatible clients",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 16_384,
    },
    supportsReasoning: true,
    authScheme: "bearer",
  },

  // ── DeepSeek (sdkFamily: openai-chat) ───────────────────────────
  {
    id: "deepseek",
    label: "DeepSeek",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    envVar: "DEEPSEEK_API_KEY",
    keyHint: "Get a key at https://platform.deepseek.com — uses OpenAI-compatible API",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    },
    supportsReasoning: true,
    authScheme: "bearer",
  },

  // ── Cerebras (sdkFamily: openai-chat) ───────────────────────────
  {
    id: "cerebras",
    label: "Cerebras",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.cerebras.ai/v1",
    envVar: "CEREBRAS_API_KEY",
    keyHint: "Get a key at https://cloud.cerebras.ai — OpenAI-compatible",
    defaultModel: "llama-3.3-70b",
    models: ["llama-3.3-70b", "llama-3.1-8b", "qwen-3-32b"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_384,
    },
    supportsReasoning: false,
    authScheme: "bearer",
  },

  // ── OpenRouter (sdkFamily: openai-chat) ─────────────────────────
  {
    id: "openrouter",
    label: "OpenRouter",
    sdkFamily: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    envVar: "OPENROUTER_API_KEY",
    keyHint: "Get a key at https://openrouter.ai/keys — proxies 100+ models",
    defaultModel: "anthropic/claude-sonnet-4",
    models: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-4.1",
      "google/gemini-2.5-pro",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 200_000,
      maxOutputTokens: 16_384,
    },
    supportsReasoning: true,
    authScheme: "bearer",
  },
];

/**
 * Lookup by id. Returns `undefined` if the id is not in the catalog.
 * Pure data — no side effects.
 */
export function findProviderDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
