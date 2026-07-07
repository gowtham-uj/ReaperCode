import { z } from "zod";

import { ConnectionPoliciesSchema } from "../connection/policies.js";
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
    serviceSupervisor: z
      .object({
        enabled: z.boolean().default(true),
        readinessTimeoutMs: z.number().int().positive().default(30_000),
        minimumStableMs: z.number().int().nonnegative().default(1_500),
        autoRecover: z.boolean().default(true),
        maxAutoRecoveriesPerService: z.number().int().nonnegative().default(1),
        crashLoopThreshold: z.number().int().positive().default(2),
      })
      .strict()
      .optional()
      .default({
        enabled: true,
        readinessTimeoutMs: 30_000,
        minimumStableMs: 1_500,
        autoRecover: true,
        maxAutoRecoveriesPerService: 1,
        crashLoopThreshold: 2,
      }),
  })
  .strict()
  .optional()
  .default({
    recedingHorizonPlanContext: true,
    voteAttempts: 1,
    serviceSupervisor: {
      enabled: true,
      readinessTimeoutMs: 30_000,
      minimumStableMs: 1_500,
      autoRecover: true,
      maxAutoRecoveriesPerService: 1,
      crashLoopThreshold: 2,
    },
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
    softCap: z.number().int().positive().default(270_000),
    shakeTriggerPct: z.number().min(1).max(99).default(50),
    shakeProtectWindowChars: z.number().int().nonnegative().default(12_000),
    shakeMinSavingsChars: z.number().int().nonnegative().default(100),
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
    bashHeadTailEnabled: z.boolean().default(true),
    bashHeadPreviewChars: z.number().int().positive().default(1_200),
    bashTailPreviewChars: z.number().int().positive().default(1_200),
    bashPersistThresholdChars: z.number().int().positive().default(30_000),
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
    warningThresholdRatio: z.number().min(0).max(1).default(0.70),
    errorThresholdRatio: z.number().min(0).max(1).default(0.85),
    blockingThresholdRatio: z.number().min(0).max(1).default(0.95),
  })
  .strict()
  .optional()
  .default({
    softCap: 270_000,
    shakeTriggerPct: 50,
    shakeProtectWindowChars: 12_000,
    shakeMinSavingsChars: 100,
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
    bashHeadTailEnabled: true,
    bashHeadPreviewChars: 1_200,
    bashTailPreviewChars: 1_200,
    bashPersistThresholdChars: 30_000,
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
