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
    label: "Anthropic",
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

  // ── MiniMax OAuth proxy (sdkFamily: openai-chat) ───────────────
  {
    id: "minimax-oauth",
    label: "MiniMax (OAuth)",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.minimax.io/v1",
    envVar: "MINIMAX_OAUTH_TOKEN",
    keyHint: "OAuth token for MiniMax's OpenAI-compatible endpoint",
    defaultModel: "MiniMax-M3",
    models: ["MiniMax-M3"],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: false,
      embeddings: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 4096,
    },
    authScheme: "bearer",
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

  // ── NuralWatt / NeuralWatt (sdkFamily: openai-chat) ────────────
  {
    id: "nuralwatt",
    label: "NuralWatt (NeuralWatt API)",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    envVar: "NURALWATT_API_KEY",
    keyHint: "Uses NURALWATT_API_KEY from the env file against NeuralWatt's OpenAI-compatible /v1 endpoint",
    defaultModel: "kimi-k2.7-code",
    models: [
      "kimi-k2.7-code",
      "kimi-k2.7-code-flex",
      "qwen3.6-35b",
      "qwen3.6-35b-fast",
      "glm-5.2",
      "glm-5.2-fast",
      "glm-5.2-flex",
      "glm-5.2-short",
      "glm-5.2-short-flex",
      "glm-5.2-short-fast",
      "glm-5.2-short-fast-flex",
      "kimi-k2.6",
      "kimi-k2.6-fast",
      "kimi-k2.6-flex",
      "qwen3.5-397b",
      "qwen3.5-397b-fast",
    ],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 262_128,
      maxOutputTokens: 32_000,
    },
    supportsReasoning: true,
    authScheme: "bearer",
  },

  // ── NuralWatt2 — second NeuralWatt key (sdkFamily: openai-chat) ─
  {
    id: "nuralwatt2",
    label: "NuralWatt2 (NeuralWatt API — key 2)",
    sdkFamily: "openai-chat",
    baseUrl: "https://api.neuralwatt.com/v1",
    envVar: "NURALWATT_API_KEY2",
    keyHint: "Uses NURALWATT_API_KEY2 from the env file against NeuralWatt's OpenAI-compatible /v1 endpoint",
    defaultModel: "kimi-k2.7-code",
    models: [
      "kimi-k2.7-code",
      "kimi-k2.7-code-flex",
      "qwen3.6-35b",
      "qwen3.6-35b-fast",
      "glm-5.2",
      "glm-5.2-fast",
      "glm-5.2-flex",
      "glm-5.2-short",
      "glm-5.2-short-flex",
      "glm-5.2-short-fast",
      "glm-5.2-short-fast-flex",
      "kimi-k2.6",
      "kimi-k2.6-fast",
      "kimi-k2.6-flex",
      "qwen3.5-397b",
      "qwen3.5-397b-fast",
    ],
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 262_128,
      maxOutputTokens: 32_000,
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
];

/**
 * Lookup by id. Returns `undefined` if the id is not in the catalog.
 * Pure data — no side effects.
 */
export function findProviderDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id);
}
