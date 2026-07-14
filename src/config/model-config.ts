import { z } from "zod";

import { ConnectionPoliciesSchema } from "../connection/policies.js";
import {
  REAPER_CONTEXT_HARD_CAP_TOKENS,
  REAPER_DEFAULT_SOFT_CAP_TOKENS,
} from "./context-hard-cap.js";
import {
  ModelCapabilitiesSchema,
  ModelRoleInputSchema,
  ModelProfileSchema,
  ModelRoleSchema,
  modelRoleValues,
  resolveModelRoleAlias,
  type ModelProfile,
  type ModelRole,
  type ResolvedModelProfile,
} from "../model/types.js";
import { McpConfigSchema } from "../tools/mcp/config.js";

const optionalRoleEntries = Object.fromEntries(
  modelRoleValues
    .filter((role) => role !== "default_model")
    .map((role) => [role, ModelProfileSchema.optional()]),
) as Record<Exclude<ModelRole, "default_model">, z.ZodOptional<typeof ModelProfileSchema>>;

export const ModelsConfigSchema = z
  .object({
    default_model: ModelProfileSchema,
    ...optionalRoleEntries,
  })
  .strict()
  .superRefine((models, ctx) => {
    for (const [role, profile] of Object.entries(models) as Array<[ModelRole, ModelProfile | undefined]>) {
      if (!profile?.fallbackProfile) {
        continue;
      }

      if (!models[profile.fallbackProfile]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [role, "fallbackProfile"],
          message: `Fallback profile '${profile.fallbackProfile}' is not configured`,
        });
      }
    }
  });

export const RuntimeControlConfigSchema = z
  .object({
    recedingHorizonPlanContext: z.boolean().default(true),
    voteAttempts: z.number().int().positive().default(1),
  })
  .strict()
  .optional()
  .default({
    recedingHorizonPlanContext: true,
    voteAttempts: 1,
  });

export const VerificationGateConfigSchema = z
  .object({
    requireGroundedCompletion: z.boolean().default(true),
    enforceFailBeforeFixForGeneratedChecks: z.boolean().default(true),
    selfDebugExplanation: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional()
      .default({ enabled: true }),
    freshContextDiffReview: z
      .object({
        enabled: z.boolean().default(true),
        maxDiffChars: z.number().int().positive().default(12_000),
      })
      .strict()
      .optional()
      .default({ enabled: true, maxDiffChars: 12_000 }),
    contractCoverage: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional()
      .default({ enabled: true }),
    executionConsensusRanking: z.boolean().default(true),
  })
  .strict()
  .optional()
  .default({
    requireGroundedCompletion: true,
    enforceFailBeforeFixForGeneratedChecks: true,
    selfDebugExplanation: { enabled: true },
    freshContextDiffReview: { enabled: true, maxDiffChars: 12_000 },
    contractCoverage: { enabled: true },
    executionConsensusRanking: true,
  });

/**
 * Context-management knobs (shake, time-MC, full-summarization). All
 * optional with defaults so existing tests keep passing. Users fill
 * in the values they want in `.reaper/config.json` to override.
 */
export const ContextManagementConfigSchema = z
  .object({
    shakeEnabled: z.boolean().default(true),
    /**
     * Soft token budget for compaction layers. Default and hard max
     * are 270k — even when a model advertises 1M context, Reaper only
     * budgets up to {@link REAPER_CONTEXT_HARD_CAP_TOKENS}. Values
     * above the hard cap are clamped (not rejected) so older configs
     * keep loading.
     * Do not set this below the post-compact rebuild size (cockpit +
     * summary + re-anchor) or full_summary will thrash every turn.
     */
    softCap: z
      .number()
      .int()
      .positive()
      .default(REAPER_DEFAULT_SOFT_CAP_TOKENS)
      .transform((v) => Math.min(v, REAPER_CONTEXT_HARD_CAP_TOKENS)),
    /** Fire shake around mid-budget so cheap prune runs before summary. */
    shakeTriggerPct: z.number().min(1).max(99).default(60),
    /** Keep recent tool evidence (KEY harvests, writes) through shake. OMP ~16k tokens. */
    shakeProtectWindowChars: z.number().int().nonnegative().default(64_000),
    /** OMP shake minSavings ~4k tokens. */
    shakeMinSavingsChars: z.number().int().nonnegative().default(16_000),
    maxConsecutiveShakeFailures: z.number().int().positive().default(3),
    ptlRecoveryMaxDrops: z.number().int().nonnegative().default(5),
    ptlRecoveryMinChars: z.number().int().positive().default(200),
    spilloverThresholdBytes: z.number().int().positive().default(8_192),
    spilloverPreviewChars: z.number().int().positive().default(1_200),
    timeMicrocompactEnabled: z.boolean().default(true),
    timeMicrocompactGapMs: z.number().int().positive().default(5 * 60 * 1000),
    timeMicrocompactKeepRecent: z.number().int().nonnegative().default(5),
    fullSummaryEnabled: z.boolean().default(true),
    fullSummaryMaxFilesToRestore: z.number().int().nonnegative().default(5),
    fullSummaryFileTokenBudget: z.number().int().positive().default(50_000),
    fullSummaryMaxPtlRetries: z.number().int().nonnegative().default(3),
    fullSummaryMinCharsForPtlDrop: z.number().int().positive().default(200),
    /** Reject a summary body above the 4,096-token/16KiB output envelope. */
    fullSummaryMaxOutputChars: z.number().int().positive().max(16_384).default(16_000),
    /** Keep raw context unless compaction saves at least this fraction. */
    fullSummaryMinSavingsRatio: z.number().min(0).max(1).default(0.10),
    /** Bounded durable-fact registry embedded in each checkpoint. */
    fullSummaryGoldenFactsMaxChars: z.number().int().nonnegative().max(16_000).default(4_000),
    /**
     * After a full_summary, suppress another until at least this many
     * tool batches complete (or token growth clears the cooldown).
     * Prevents summary thrash when post-compact rebuild is still large.
     */
    fullSummaryCooldownMinToolBatches: z.number().int().nonnegative().default(2),
    /**
     * After a full_summary, suppress another until tokens grow by this
     * many past the post-summary baseline. 0 = derive as 8% of softCap.
     */
    fullSummaryCooldownMinTokenGrowth: z.number().int().nonnegative().default(0),
    bashHeadTailEnabled: z.boolean().default(true),
    bashHeadPreviewChars: z.number().int().positive().default(1_200),
    bashTailPreviewChars: z.number().int().positive().default(1_200),
    bashPersistThresholdChars: z.number().int().positive().default(25_000),
    /**
     * Promote Context Model (#21, OMP port):
     * Before triggering full-summary, check if the active mainAgent
     * profile has a sibling profile with a strictly larger
     * `capabilities.maxContextTokens`. If so, recommend a model swap
     * (written to trajectory as `promoted_context_model`). The engine
     * reads the recommendation and applies the swap, avoiding a
     * wasteful compaction.
     */
    modelPromotionEnabled: z.boolean().default(true),
    /**
     * Threshold (token ratio) at which promotion is considered. When
     * `tokensAfterShake / softCap >= modelPromotionThresholdRatio`,
     * the wiring inspects sibling profiles and recommends a swap.
     *
     * Defaults to 0.5 — fires before the `blockingThresholdRatio`
     * (0.95) so we never waste a compaction on a profile that could
     * just be swapped to a larger-context sibling.
     */
    modelPromotionThresholdRatio: z.number().min(0).max(1).default(0.5),
    /**
     * The role name to promote INTO when the conversation overflows.
     * Defaults to `"secondary_model"` (the canonical name in
     * `ModelRoleValues`). Users can override to a different role
     * registered in `config.models`. The wiring picks the sibling
     * with the largest `capabilities.maxContextTokens` ≥ the
     * active profile's. Set to `null` to disable the auto-pick and
     * only emit the `promoted_context_model` trajectory event
     * without changing the active profile.
     */
    modelPromotionTargetRole: z
      .union([ModelRoleInputSchema, z.null()])
      .default("secondary_model"),
    /**
     * Idle Compaction (T1 OMP port): when the model is not actively
     * generating a turn (no streaming, no tool running) AND context
     * tokens exceed `idleThresholdTokens`, schedule a proactive
     * compaction via `setTimeout(idleTimeoutSeconds * 1000)`. OMP
     * equivalent of `event-controller.ts:#scheduleIdleCompaction`.
     *
     * Defaults to `false` to match OMP — most runs complete within a
     * turn and don't need it. Set to `true` for days-long autonomous
     * sessions where the user might be away from the keyboard.
     */
    idleEnabled: z.boolean().default(false),
    /**
     * Token-count threshold at which idle compaction fires. Default
     * 200_000 matches OMP (~74% of Reaper's 270k hard cap). Idle still
     * requires `idleEnabled: true`.
     */
    idleThresholdTokens: z.number().int().min(0).default(200_000),
    /**
     * How long the model must be idle before proactive compaction
     * fires. Clamped to [60, 3600] seconds per OMP's `Math.max(60,
     * Math.min(3600, idleTimeoutSeconds))` pattern. Default 300s (5
     * min) matches OMP's typical authoring-session value.
     */
    idleTimeoutSeconds: z.number().int().min(60).max(3600).default(300),
    /**
     * Incomplete (length-stop) recovery (T2 OMP port): when the model
     * emits `stopReason === "length"` (i.e. hit `max_output_tokens`
     * without producing a usable deliverable), proactively compact
     * before the next model call. OMP equivalent of
     * `#checkCompaction("incomplete", assistantMessage)`.
     *
     * Defaults to `true` to match the rest of the OMP-defaulted
     * layers. Disable for fully-streaming models that never hit
     * `max_output_tokens`.
     */
    incompleteRecoveryEnabled: z.boolean().default(true),
    /**
     * Handoff (T3 OMP port): smaller-context summarization as an
     * alternative to `full_summary`. The handoff LLM call produces a
     * tighter narrative focused on the active task rather than the
     * full 9-section OMP summary template. Fires on the same OMP gate
     * (`tokensAfterShake > softCap - reserve`).
     *
     * When `handoffEnabled` is `false`, `full_summary` is used (the
     * default). Set to `true` to prefer the smaller handoff.
     */
    handoffEnabled: z.boolean().default(false),
    /**
     * Snapcompact (T4 OMP port): image-cluster-aware compaction
     * variant. OMP's snapcompact collapses consecutive image blocks
     * into a single summary stub before the conversation grows. Reaper
     * treats images as opaque text (no media channels), so this
     * layer is a no-op when there are no image blocks in the live
     * conversation. Set `snapcompactEnabled` to `true` to enable the
     * hook; it will simply be inert for non-image conversations.
     */
    snapcompactEnabled: z.boolean().default(false),
    warningThresholdRatio: z.number().min(0).max(1).default(0.70),
    errorThresholdRatio: z.number().min(0).max(1).default(0.85),
    blockingThresholdRatio: z.number().min(0).max(1).default(0.95),
  })
  .strict()
  .optional()
  .default({
    softCap: REAPER_DEFAULT_SOFT_CAP_TOKENS,
    shakeTriggerPct: 60,
    shakeProtectWindowChars: 64_000,
    shakeMinSavingsChars: 16_000,
    maxConsecutiveShakeFailures: 3,
    ptlRecoveryMaxDrops: 5,
    ptlRecoveryMinChars: 200,
    spilloverThresholdBytes: 8_192,
    spilloverPreviewChars: 1_200,
    timeMicrocompactEnabled: true,
    timeMicrocompactGapMs: 5 * 60 * 1000,
    timeMicrocompactKeepRecent: 5,
    fullSummaryEnabled: true,
    fullSummaryMaxFilesToRestore: 5,
    fullSummaryFileTokenBudget: 50_000,
    fullSummaryMaxPtlRetries: 3,
    fullSummaryMinCharsForPtlDrop: 200,
    fullSummaryMaxOutputChars: 16_000,
    fullSummaryMinSavingsRatio: 0.10,
    fullSummaryGoldenFactsMaxChars: 4_000,
    fullSummaryCooldownMinToolBatches: 2,
    fullSummaryCooldownMinTokenGrowth: 0,
    bashHeadTailEnabled: true,
    bashHeadPreviewChars: 1_200,
    bashTailPreviewChars: 1_200,
    bashPersistThresholdChars: 25_000,
    modelPromotionEnabled: true,
    modelPromotionThresholdRatio: 0.5,
    modelPromotionTargetRole: "secondary_model",
    idleEnabled: false,
    idleThresholdTokens: 200_000,
    idleTimeoutSeconds: 300,
    incompleteRecoveryEnabled: true,
    handoffEnabled: false,
    snapcompactEnabled: false,
    warningThresholdRatio: 0.70,
    errorThresholdRatio: 0.85,
    blockingThresholdRatio: 0.95,
  });

export const ModelRoutingConfigSchema = z
  .object({
    default_model: ModelRoleInputSchema.default("default_model"),
    mainAgent: ModelRoleInputSchema.default("secondary_model"),
    planner: ModelRoleInputSchema.default("secondary_model"),
    executor: ModelRoleInputSchema.default("fast_reasoner"),
    repair: ModelRoleInputSchema.default("secondary_model"),
    patcher: ModelRoleInputSchema.default("fast_reasoner"),
    completionGate: ModelRoleInputSchema.default("fast_reasoner"),
    summarizer: ModelRoleInputSchema.default("fast_reasoner"),
    judge: ModelRoleInputSchema.default("judge"),
  })
  .strict()
  .optional()
  .default({
    mainAgent: "secondary_model",
    planner: "secondary_model",
    executor: "fast_reasoner",
    repair: "secondary_model",
    patcher: "fast_reasoner",
    completionGate: "fast_reasoner",
    summarizer: "fast_reasoner",
    judge: "judge",
  });

/**
 * Runtime tunables — every REAPER_* env var that previously lived in
 * the environment now lives in the config file. All fields are
 * optional with the same defaults the source code previously used as
 * inline fallbacks. The strict (no-defaults) variant is enforced by
 * `parseStrictReaperConfig` for users who want to fail-fast on missing
 * values.
 */
export const RuntimeTunablesConfigSchema = z
  .object({
    bashAssistantBlockingBudgetMs: z.number().int().nonnegative().default(120_000),
    bashDefaultTimeoutMs: z.number().int().positive().default(60_000),
    bashIdleTimeoutMs: z.number().int().positive().default(45_000),
    bashPersistThresholdChars: z.number().int().nonnegative().default(30_000),
    bashPreviewSizeChars: z.number().int().nonnegative().default(1_200),
    maxShellOutputBytes: z.number().int().nonnegative().default(50 * 1024 * 1024),
    stallWatchdogIntervalMs: z.number().int().nonnegative().default(10_000),
    stallWatchdogNoOutputMs: z.number().int().nonnegative().default(30_000),
    bgDescendantTermGraceMs: z.number().int().nonnegative().default(5_000),
    bgKillGraceMs: z.number().int().nonnegative().default(3_000),
    bgMaxOutputLines: z.number().int().nonnegative().default(5_000),
    bgTermGraceMs: z.number().int().nonnegative().default(5_000),
    browserExecutablePath: z.string().default(""),
    browserHeadless: z.boolean().default(true),
    computerAutoApprove: z.boolean().default(false),
    computerEnableGlobalHook: z.boolean().default(false),
    queueMaxConcurrency: z.number().int().nonnegative().default(4),
    tuiNoQueue: z.boolean().default(false),
    langgraphRecursionLimit: z.number().int().positive().default(50),
    liveModelTimeoutMs: z.number().int().positive().default(60_000),
    mainAgentTransportRetryLimit: z.number().int().nonnegative().default(2),
    modelCallTimeoutMs: z.number().int().positive().default(120_000),
    modelRouterLlmDecisions: z.boolean().default(false),
    permissionMode: z.string().default("yolo"),
    printReasoning: z.boolean().default(false),
    progressGuardV2: z.boolean().default(true),
    rescueMaxAttemptsPerDiagnostic: z.number().int().nonnegative().default(1),
    rescueMaxStagnantTurns: z.number().int().nonnegative().default(8),
    retryBaseDelayMs: z.number().int().nonnegative().default(500),
    retryDeadlineHeadroomMs: z.number().int().nonnegative().default(5_000),
    retryFallbackAfterOverloaded: z.boolean().default(true),
    retryKeepAliveMs: z.number().int().nonnegative().default(1_500),
    retryMaxDelayMs: z.number().int().nonnegative().default(8_000),
    retryMaxRetries: z.number().int().nonnegative().default(3),
    runDeadlineEpochMs: z.number().int().nonnegative().default(0),
    streamIdleTimeoutMs: z.number().int().nonnegative().default(30_000),
    strictCompletionGate: z.boolean().default(true),
    strictTempCleanup: z.boolean().default(true),
    swarmDebug: z.boolean().default(false),
    unattendedRetry: z.boolean().default(true),
    tbenchComposeProject: z.string().default(""),
    tbenchContainerName: z.string().default(""),
    tbenchHostWorkspace: z.string().default(""),
    workspacePathAliases: z.string().default(""),
  })
  .strict()
  .optional()
  .default({});

/**
 * Secrets block — every API credential lives here. Optional with empty
 * string defaults so existing tests keep passing; users fill in the
 * values they need in their `.reaper/config.json`.
 */
export const SecretsConfigSchema = z
  .object({
    anthropicApiKey: z.string().default(""),
    anthropicAuthToken: z.string().default(""),
    anthropicBaseUrl: z.string().default("https://api.anthropic.com"),
    anthropicModel: z.string().default(""),
    anthropicVersion: z.string().default("2023-06-01"),
    openaiApiKey: z.string().default(""),
    openaiBaseUrl: z.string().default("https://api.openai.com/v1"),
    openaiCodexAccessToken: z.string().default(""),
    deepseekApiKey: z.string().default(""),
    minimaxApiKey: z.string().default(""),
    nuralwattApiKey: z.string().default(""),
    nuralwattApiKey2: z.string().default(""),
    openrouterApiKey: z.string().default(""),
    cerebrasApiKey: z.string().default(""),
    azureOpenAiApiVersion: z.string().default(""),
    azureOpenAiBaseUrl: z.string().default(""),
    serperSearchApiKey: z.string().default(""),
    mimoSearchApiKey: z.string().default(""),
  })
  .strict()
  .optional()
  .default({});

export const ReaperConfigSchema = z
  .object({
    connection: ConnectionPoliciesSchema.optional().default({}),
    logging: z
      .object({
        devMode: z.boolean().default(false),
        sampleRate: z.number().min(0).max(1).default(1.0),
        sessionMetrics: z.boolean().default(true),
      })
      .strict()
      .optional()
      .default({ devMode: false, sampleRate: 1.0, sessionMetrics: true }),
    pruner: z
      .object({
        enabled: z.boolean().default(true),
        localOnly: z.boolean().default(true),
        url: z.string().url().optional(),
        threshold: z.number().min(0).max(1).default(0.5),
      })
      .strict()
      .optional()
      .default({ enabled: true, localOnly: true, threshold: 0.5 }),
    runtime: RuntimeControlConfigSchema,
    verification: VerificationGateConfigSchema,
    modelRouting: ModelRoutingConfigSchema,
    models: ModelsConfigSchema,
    mcp: McpConfigSchema.optional().default({ enabled: true, maxActiveMCPTools: 6, refreshIntervalTurns: 10, servers: [] }),
    contextManagement: ContextManagementConfigSchema,
    runtimeTunables: RuntimeTunablesConfigSchema,
  })
  .strict();

export type ReaperConfig = z.infer<typeof ReaperConfigSchema>;

export function parseReaperConfig(input: unknown): ReaperConfig {
  if (process.env.REAPER_DEBUG_CONFIG_MERGE) {
    process.stderr.write(`[parse:debug] called with keys: ${Object.keys((input as any) || {}).join(',')}\n`);
  }
  return ReaperConfigSchema.parse(input);
}

export function resolveModelRole(config: ReaperConfig, role: ModelRole): ResolvedModelProfile {
  const profile = config.models[role] ?? config.models.default_model;

  if (!profile) {
    throw new Error(`No model profile available for role '${role}'`);
  }

  return {
    ...profile,
    profileName: (config.models[role] ? role : "default_model") as ModelRole,
    role,
  };
}

export function assertRoleCapabilities(config: ReaperConfig, role: ModelRole): void {
  const profile = resolveModelRole(config, role);
  const capabilities = profile.capabilities;
  // The `embedder` role was historically part of the role enum but
  // was removed in v0.2 when embeddings moved out-of-scope. Kept as
  // no-op for legacy callers that still pass `embedder` through the
  // role alias machinery (which maps it to "default_model").
  if (role === ("embedder" as unknown as ModelRole) && !capabilities.embeddings) {
    throw new Error(`Role '${role}' requires a profile with embeddings=true`);
  }
}

export function parseModelCapabilities(input: unknown) {
  return ModelCapabilitiesSchema.parse(input);
}

export function parseModelRole(input: unknown) {
  if (typeof input === "string") {
    const resolved = resolveModelRoleAlias(input);
    if (resolved) return resolved;
  }
  return ModelRoleSchema.parse(input);
}
