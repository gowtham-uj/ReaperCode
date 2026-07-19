import { z } from "zod";

/**
 * Model role identifiers (the canonical role name used in
 * `config.models.<role>` and `config.modelRouting.<route>`).
 *
 * History: Reaper's "main" coding model was historically called
 * `main_reasoner` and aliased to `strong_model`. As of v0.2 the
 * canonical role is `secondary_model` — same semantics (a
 * higher-context/larger-context alternative to `default_model`
 * that the OMP-promote-context-model layer can swap into
 * `modelRouting.mainAgent` when the conversation overflows).
 *
 * Backward compatibility: `resolveModelRoleAlias` and
 * `ModelRoleInputSchema` still accept the legacy string
 * `main_reasoner` (and the alias `strong_model`) and translate
 * them to `secondary_model`. New configs should use
 * `secondary_model` directly.
 */
export const modelRoleValues = [
  "default_model",
  "secondary_model",
  "fast_reasoner",
  "summarizer",
  "judge",
  "completion_gate",
] as const;

export const ModelRoleSchema = z.enum(modelRoleValues);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

/**
 * Profile display names. `secondary_model` is the canonical role
 * for the larger-context sibling profile. We keep the
 * `strong_model` alias for backward compatibility with older
 * configs and as a friendly display name (printed in logs).
 */
export const modelProfileAliases = {
  secondary_model: "secondary_model",
  fast_reasoner: "fast_model",
  /**
   * Legacy aliases — these are NOT in `modelRoleValues` but
   * `getLegacyModelRole` resolves them to `secondary_model` for
   * backward compatibility with configs written before the rename.
   */
} as const;

/**
 * Backward-compatibility alias table for legacy role/alias names
 * that may appear in older on-disk configs. Both keys resolve to
 * the canonical `secondary_model` role.
 */
const modelProfileAliasToRole: Record<string, ModelRole> = {
  strong_model: "secondary_model",
  main_agent: "secondary_model",
  main_reasoner: "secondary_model",
  secondary_model: "secondary_model",
};

export function getModelProfileName(role: ModelRole): string {
  return (modelProfileAliases as Partial<Record<ModelRole, string>>)[role] ?? role;
}

export function displayModelProfile(roleOrProfile: string): string {
  const role = resolveModelRoleAlias(roleOrProfile);
  return role ? getModelProfileName(role) : roleOrProfile;
}

export function profileFromLegacyRole(roleOrProfile: string): string {
  return displayModelProfile(roleOrProfile);
}

export function getLegacyModelRole(roleOrAlias: string): ModelRole | undefined {
  if (Object.prototype.hasOwnProperty.call(modelProfileAliasToRole, roleOrAlias)) {
    return modelProfileAliasToRole[roleOrAlias]!;
  }
  return undefined;
}

export function resolveModelRoleAlias(roleOrAlias: string): ModelRole | undefined {
  if ((modelRoleValues as readonly string[]).includes(roleOrAlias)) {
    return roleOrAlias as ModelRole;
  }
  return getLegacyModelRole(roleOrAlias);
}

export const ModelRoleInputSchema = z.preprocess(
  (value) => (typeof value === "string" ? resolveModelRoleAlias(value) ?? value : value),
  ModelRoleSchema,
);

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    toolCalling: z.boolean(),
    jsonMode: z.boolean(),
    structuredOutput: z.boolean(),
    embeddings: z.boolean(),
    maxContextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict();

export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const ModelProfileSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    apiBase: z.string().min(1).optional(),
    apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
    timeoutMs: z.number().int().nonnegative().optional(),
    maxRetries: z.number().int().min(0).optional(),
    fallbackProfile: ModelRoleInputSchema.optional(),
    capabilities: ModelCapabilitiesSchema,
    defaultParams: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().positive().optional(),
        topP: z.number().min(0).max(1).optional(),
        stop: z.array(z.string().min(1)).optional(),
        // OpenAI reasoning-model knob. Accept either the new
        // string-literal form ("low" | "medium" | "high") or the
        // legacy numeric form. Per-request override also exists on
        // GenerateRequest; this is the profile-level default.
        reasoningEffort: z
          .union([z.enum(["low", "medium", "high"]), z.number().int().min(0).max(100)])
          .optional(),
        promptCache: z
          .object({
            enabled: z.boolean(),
            minContentChars: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export interface ResolvedModelProfile extends ModelProfile {
  profileName: ModelRole;
  role: ModelRole;
}

export interface GenerateRequest {
  role: ModelRole;
  source?: string;
  system?: string;
  messages: Array<{
    role: string;
    content: string;
    /** For `tool` role: the originating `tool_call_id`. */
    tool_call_id?: string;
    /** Internal tool-name hint for `tool` messages; stripped before OpenAI wire. */
    name?: string;
    /** Internal error hint for `tool` messages; stripped before OpenAI wire. */
    is_error?: boolean;
    /** For `assistant` role: OpenAI chat-completions tool-call objects. */
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  tools?: unknown[];
  responseFormat?: "text" | "json";
  temperature?: number;
  maxTokens?: number;
  /**
   * Optional external abort signal. Provider clients should compose this
   * with their own internal timeouts so an upstream cancel stops the
   * network call promptly without waiting for the provider timeout.
   */
  abortSignal?: AbortSignal;
}

/**
 * Token usage reported by the provider for this call. Phase T2.7:
 * every provider client that can extract usage from its response now
 * populates this; consumers (the engine's TokenBudgetTracker and the
 * `token_budget` trajectory event) treat it as best-effort.
 *
 * Providers that don't report usage (or where the route doesn't
 * surface it) leave it undefined — that's fine; the tracker
 * silently skips undefined records.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerateResult {
  role: ModelRole;
  profileName: ModelRole;
  provider: string;
  model: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: unknown[];
  finishReason?: string;
  /**
   * Provider-reported token usage. Best-effort — undefined when the
   * provider doesn't surface a usage envelope (e.g. some LiteLLM
   * routes, mock providers for tests).
   */
  usage?: TokenUsage;
  raw: unknown;
}

export interface StreamEvent {
  type:
    | "message_start"
    | "message_delta"
    | "reasoning_delta"
    | "tool_call"
    /**
     * Pi-parity tool-execution streaming vocabulary. Emitted by the
     * runtime / executor (not the model gateway), so `tool_call` from
     * the gateway stays the source of truth for what the model asked
     * for. The runtime emits:
     *   - `tool_execution_start`  as soon as the executor begins
     *     dispatch (name + args + toolCallId)
     *   - `tool_execution_delta`  partial-output chunks for tools
     *     that opt in to streaming (currently bash and eval). Other
     *     tools emit zero of these.
     *   - `tool_execution_complete` with the final `ToolResult` once
     *     the dispatch resolves (success or failure).
     * Callers that do not consume these (existing mock gateways, the
     * legacy parity `tool_call`-only path) are unaffected.
     */
    | "tool_execution_start"
    | "tool_execution_delta"
    | "tool_execution_complete"
    | "message_end"
    | "error";
  content?: string;
  reasoning?: string;
  data?: unknown;
}

export interface EmbeddingRequest {
  role: ModelRole;
  input: string | string[];
}

export interface EmbeddingResult {
  role: ModelRole;
  profileName: ModelRole;
  provider: string;
  model: string;
  vectors: number[][];
  raw: unknown;
}

export interface TokenCountRequest {
  role: ModelRole;
  text: string;
}

export interface ModelGateway {
  resolveRole(role: ModelRole): Promise<ResolvedModelProfile>;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
  countTokens(request: TokenCountRequest): Promise<number>;
  dispose?(): Promise<void>;
}
