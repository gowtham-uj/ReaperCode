/**
 * model/provider/types.ts — the decoupling layer.
 *
 * Goal: separate "which vendor's API" (provider) from "which wire format
 * its API speaks" (sdk family) from "the agent loop". The loop imports
 * exactly one type from this module: `ModelProvider`. Everything else
 * (SDK family, base URL, env var, capability flags) lives behind a
 * data-driven registry.
 *
 * Two SDK families ship built-in:
 *   - `anthropic-messages` — Anthropic's native /v1/messages wire.
 *   - `openai-chat`        — the OpenAI /v1/chat/completions wire.
 *
 * MiniMax, DeepSeek, OpenAI, OpenRouter, Cerebras, etc. all speak
 * `openai-chat`; the differences between them are the base URL, the
 * env var, and capability flags, not the wire format itself.
 *
 * For vendors that ship their own wire (Bedrock, Azure ADX, etc.),
 * the catalog entry declares `sdkFamily: "custom"` and points at
 * a JS module path that exports a `ProviderModelClient`. The agent
 * loop never sees the difference.
 *
 * Providers now come from the pinned Models.dev catalog snapshot and
 * run through AI SDK transports; see `README.md` in this directory for
 * how to add a transport identity. These descriptors remain for the
 * legacy hand-written clients.
 */

import type { ModelCapabilities, ModelRole } from "../types.js";
import type { ModelCost, ModelReasoningOption } from "./models-dev-types.js";

/**
 * The SDK family. Each id corresponds to a built-in wire-format
 * implementation; `"custom"` is the escape hatch.
 */
export type SdkFamilyId =
  | "anthropic-messages"
  | "openai-chat"
  | "custom";

/**
 * Vendor identifier. The agent loop never inspects this string —
 * it's used for routing + telemetry only.
 */
export type ProviderId = string;

/** Public model metadata used by Settings and the composer. The runtime keeps
 * using `ResolvedModelProfile`; this is the provider-catalog side of the same
 * model, keeping providers and their models separate. */
export interface ProviderModelDescriptor {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  status?: "active" | "alpha" | "beta" | "deprecated";
  releaseDate?: string;
  lastUpdated?: string;
  contextTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  supportsReasoning?: boolean;
  reasoningOptions?: ModelReasoningOption[];
  supportsAttachments?: boolean;
  supportsToolCalls?: boolean;
  supportsTemperature?: boolean;
  supportsStructuredOutput?: boolean;
  modalities?: {
    input: Array<"text" | "audio" | "image" | "video" | "pdf">;
    output: Array<"text" | "audio" | "image" | "video" | "pdf">;
  };
  cost?: ModelCost;
  npm?: string;
  api?: string;
}

export type ProviderAuthPrompt =
  | {
      type: "text";
      key: string;
      message: string;
      placeholder?: string;
      secret?: boolean;
      optional?: boolean;
      when?: { key: string; op: "eq" | "neq"; value: string };
    }
  | {
      type: "select";
      key: string;
      message: string;
      options: Array<{ label: string; value: string; hint?: string }>;
      when?: { key: string; op: "eq" | "neq"; value: string };
    };

export interface ProviderApiAuthMethod {
  id: string;
  type: "api";
  label: string;
  /** Optional non-secret account fields stored beside the key. */
  prompts?: ProviderAuthPrompt[];
}

export interface ProviderOAuthSuccess {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

export type ProviderAuthSuccess =
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | ProviderOAuthSuccess;

export type ProviderOAuthPollResult =
  | { type: "pending" }
  | { type: "success"; auth: ProviderAuthSuccess }
  | { type: "failed"; message: string };

export interface ProviderOAuthAuthorization {
  url: string;
  mode: "auto" | "code";
  instructions: string;
  /** Complete a code flow, or poll an automatic/device flow. Server-only. */
  complete(code?: string): Promise<ProviderOAuthPollResult>;
}

export interface ProviderOAuthAuthMethod {
  id: string;
  type: "oauth";
  label: string;
  prompts?: ProviderAuthPrompt[];
  authorize(inputs?: Record<string, string>): Promise<ProviderOAuthAuthorization>;
}

export type ProviderAuthMethod = ProviderApiAuthMethod | ProviderOAuthAuthMethod;

/** One deliberately supported provider integration. Provider definitions,
 * authentication and post-auth model discovery stay together, while secret
 * state lives in the user-global credential store. */
export interface ProviderIntegration {
  descriptor: ProviderDescriptor;
  authMethods: ProviderAuthMethod[];
  discoverModels?: (auth: ProviderAuthSuccess) => Promise<ProviderModelDescriptor[]>;
  /** Refresh an expiring OAuth record. Runs server-side and may rotate refresh tokens. */
  refreshOAuth?: (auth: ProviderOAuthSuccess) => Promise<ProviderOAuthSuccess>;
}

/**
 * Catalogue entry. Static data — no closures, no per-process state.
 * Resolved once at startup into a `ResolvedProvider`.
 */
export interface ProviderDescriptor {
  /** Vendor identifier. */
  id: ProviderId;
  /** Human label for the TUI picker / status bar. */
  label: string;
  /** Which built-in wire family this vendor speaks. */
  sdkFamily: SdkFamilyId;
  /**
   * Base URL for the API. For `openai-chat` we append `/chat/completions`;
   * for `anthropic-messages` we append `/v1/messages`. Trailing `/` is OK.
   */
  baseUrl: string;
  /**
   * Env var that holds the API key. Resolved at provider construction
   * time and held in the `Credentials` object — the agent loop never
   * reads this.
   */
  envVar: string;
  /** All environment variables recognized for this provider. */
  envVars?: string[];
  /** AI SDK package and API metadata supplied by Models.dev. */
  npm?: string;
  api?: string;
  doc?: string;
  /**
   * Hint shown beneath the API-key prompt in the TUI. e.g. "Get a key
   * at https://...".
   */
  keyHint: string;
  /**
   * Default model id when the user does not pin one. Used by the TUI
   * onboarding picker and as the fallback for `reaper exec run` /
   * `reaper tui` when no model is specified.
   */
  defaultModel: string;
  /**
   * Full model catalogue for this vendor. The TUI picker shows it.
   * `defaultModel` must be in this list.
   */
  models: string[];
  /** Rich per-model metadata for Settings. If omitted, `models` plus the
   * provider-level capabilities remain the source of truth. */
  modelDetails?: Record<string, ProviderModelDescriptor>;
  /**
   * Capability defaults. Per-model overrides can be added later; for
   * now every model in the catalogue shares the same caps.
   */
  capabilities: ModelCapabilities;
  /**
   * Optional reference to a custom client module (used only when
   * `sdkFamily === "custom"`). Format: a relative import path that
   * the registry resolves with a dynamic import. We keep it as
   * a module path string (not a function ref) so the catalogue can
   * be JSON-serialised for the TUI to display without booting the
   * provider module.
   */
  customClientModule?: string;
  /**
   * Whether this provider ships a `Reasoning` channel. When true, the
   * engine can surface a `reasoningContent` field in the assistant
   * turn (already supported by `GenerateResult`).
   */
  supportsReasoning?: boolean;
  /**
   * `Authorization: Bearer` vs `x-api-key` (Anthropic style). Only
   * meaningful for `openai-chat` (always `bearer`) and
   * `anthropic-messages` (always `x-api-key`). Custom families can
   * ignore this — they implement auth themselves.
   */
  authScheme?: "bearer" | "x-api-key" | "custom";
}

/**
 * A `ProviderDescriptor` resolved against the current process —
 * env vars read, capabilities frozen, custom client (if any)
 * imported. Built once at startup.
 */
export interface ResolvedProvider {
  descriptor: ProviderDescriptor;
  /** API key, resolved from `descriptor.envVar` at construction. */
  apiKey: string;
  /** Cached `TransformStream` factory used by the family adapter to
   *  convert provider SSE → engine `StreamEvent`. Constructed once. */
  sseTransformCtor?: new () => TransformStream<unknown, unknown>;
}

/**
 * A model picked from a provider's catalogue. The agent loop only
 * ever sees this — never the provider id, never the family, never
 * the base URL.
 */
export interface ResolvedModel {
  /** The provider that owns this model. */
  providerId: ProviderId;
  /** The model id within the provider. */
  modelId: string;
  /** Effective role — the user can route different roles to different
   *  models. Today we use one role per provider; this stays open for
   *  per-role routing later. */
  role: ModelRole;
  /** Snapshot of capabilities for this model. */
  capabilities: ModelCapabilities;
}

/**
 * The agent-loop-facing contract. A `ModelProvider` is a fully-
 * configured client bound to a (provider, model, role) tuple. The
 * engine constructs one per `RuntimeEngine.run()` and never
 * re-constructs per turn.
 *
 * It wraps the existing `ProviderModelClient` so legacy code paths
 * (which pass `ResolvedModelProfile` around) keep working — the
 * default `resolveProfile()` adapter converts a `ResolvedModel`
 * into a profile on demand.
 */
export interface ModelProvider {
  /** Vendor identifier, surfaced in telemetry only. */
  readonly providerId: ProviderId;
  /** SDK family used at the wire. */
  readonly sdkFamily: SdkFamilyId;
  /** The model id. */
  readonly modelId: string;
  /** Snapshot of capabilities. */
  readonly capabilities: ModelCapabilities;
  /**
   * Convert the engine's role-agnostic request into the wire format
   * this SDK family speaks and execute it. Returns the engine's
   * `GenerateResult` shape.
   */
  generate(request: ProviderCallInput): Promise<ProviderCallResult>;
  /**
   * Streaming variant. Yields engine `StreamEvent`s.
   */
  stream(request: ProviderCallInput): AsyncIterable<ProviderStreamEvent>;
  /** Dispose — release sockets, timers, etc. */
  dispose(): Promise<void>;
}

/**
 * The wire-agnostic call input. SDK families translate this into
 * their native request body.
 */
export interface ProviderCallInput {
  system?: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  responseFormat?: "text" | "json";
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Optional per-turn cache key. The Anthropic family interprets this
   * as a `prompt_cache_key` (Anthropic's cache key) and the OpenAI
   * family as a stable request identifier for prompt-cache routing.
   */
  promptCacheKey?: string;
  /** Free-form metadata; providers may stamp it into the request. */
  metadata?: Record<string, string>;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** For `tool` role: the upstream `tool_call_id`. */
  toolCallId?: string;
  /** For `assistant` role: tool calls emitted by the model. */
  toolCalls?: ProviderToolCall[];
}

export interface ProviderTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The engine's `GenerateResult` shape — vendor-agnostic.
 */
export type ProviderCallResult = {
  content: string;
  reasoningContent?: string;
  toolCalls?: ProviderToolCall[];
  finishReason: "stop" | "tool_use" | "length" | "error";
  /**
   * Token usage when the family exposes it. Anthropic surfaces it
   * in `message_delta`; OpenAI surfaces it in the final chunk. If
   * a family cannot return it, omit the field.
   */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
  };
  /** Vendor-specific raw response for telemetry. */
  raw?: unknown;
};

/**
 * The engine's `StreamEvent` shape — vendor-agnostic. Matches the
 * existing `StreamEvent` union in `model/types.ts` so the engine
 * can use them interchangeably. Re-declared here as the canonical
 * shape; the engine's existing `StreamEvent` is structurally
 * compatible.
 */
export type ProviderStreamEvent =
  | { type: "message_start"; data?: { provider: ProviderId; model: string } }
  | { type: "message_delta"; content?: string; reasoningContent?: string; data?: unknown }
  | { type: "tool_call"; call: ProviderToolCall; data?: unknown }
  | { type: "message_end"; data?: { finishReason: "stop" | "tool_use" | "length" | "error"; usage?: ProviderCallResult["usage"] } }
  | { type: "error"; data: { message: string; retryable: boolean } };

/**
 * The SDK family contract. Each built-in family implements this.
 * Custom families register an opaque `ProviderModelClient` instead.
 */
export interface SdkFamilyAdapter {
  readonly id: SdkFamilyId;
  /**
   * Build a `ModelProvider` bound to a (provider, model, role) tuple.
   * The family owns the wire format; the descriptor owns everything
   * else.
   */
  buildProvider(args: {
    descriptor: ResolvedProvider["descriptor"];
    resolved: ResolvedProvider;
    model: ResolvedModel;
  }): ModelProvider;
}
