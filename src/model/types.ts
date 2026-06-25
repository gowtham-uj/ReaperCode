import { z } from "zod";

export const modelRoleValues = [
  "default_model",
  "main_reasoner",
  "fast_reasoner",
  "judge",
  "embedder",
  "cheap_router",
  "skim_model",
  "planner",
] as const;

export const ModelRoleSchema = z.enum(modelRoleValues);
export type ModelRole = z.infer<typeof ModelRoleSchema>;
export const modelProfileAliases = {
  main_reasoner: "strong_model",
  fast_reasoner: "fast_model",
} as const satisfies Partial<Record<ModelRole, string>>;

const modelProfileAliasToRole = {
  ...Object.fromEntries(
  Object.entries(modelProfileAliases).map(([role, alias]) => [alias, role]),
  ),
  main_agent: "main_reasoner",
} as Record<string, ModelRole>;

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
  if (Object.prototype.hasOwnProperty.call(modelProfileAliases, roleOrAlias)) {
    return roleOrAlias as ModelRole;
  }
  if (Object.prototype.hasOwnProperty.call(modelProfileAliasToRole, roleOrAlias)) {
    return modelProfileAliasToRole[roleOrAlias as keyof typeof modelProfileAliasToRole];
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
  messages: Array<{ role: string; content: string }>;
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
    | "message_end"
    | "error";
  content?: string;
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
