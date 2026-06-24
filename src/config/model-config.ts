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
    progressGuard: z
      .object({
        enabled: z.boolean().default(true),
        actionRepeatLimit: z.number().int().positive().default(3),
        observationRepeatLimit: z.number().int().positive().default(3),
        sameFailedActionLimit: z.number().int().positive().default(3),
        recoveryStrategyRepeatLimit: z.number().int().positive().default(2),
        stallSteps: z.number().int().positive().default(2),
      })
      .strict()
      .optional()
      .default({
        enabled: true,
        actionRepeatLimit: 3,
        observationRepeatLimit: 3,
        sameFailedActionLimit: 3,
        recoveryStrategyRepeatLimit: 2,
        stallSteps: 2,
      }),
    completionGateMax: z.number().int().positive().default(3),
    recedingHorizonPlanContext: z.boolean().default(true),
    voteAttempts: z.number().int().positive().default(1),
    artifactObligations: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional()
      .default({ enabled: true }),
    hypothesisRescue: z
      .object({
        enabled: z.boolean().default(true),
      })
      .strict()
      .optional()
      .default({ enabled: true }),
    expandedStuckDetection: z
      .object({
        enabled: z.boolean().default(true),
        alternatingPatternLength: z.number().int().min(4).default(6),
        noActionTurnLimit: z.number().int().positive().default(3),
      })
      .strict()
      .optional()
      .default({ enabled: true, alternatingPatternLength: 6, noActionTurnLimit: 3 }),
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
    editorGuard: z
      .object({
        enabled: z.boolean().default(true),
        syntaxCheckTimeoutMs: z.number().int().positive().default(30_000),
      })
      .strict()
      .optional()
      .default({ enabled: true, syntaxCheckTimeoutMs: 30_000 }),
  })
  .strict()
  .optional()
  .default({
    progressGuard: {
      enabled: true,
      actionRepeatLimit: 3,
      observationRepeatLimit: 3,
      sameFailedActionLimit: 3,
      recoveryStrategyRepeatLimit: 2,
      stallSteps: 2,
    },
    completionGateMax: 3,
    recedingHorizonPlanContext: true,
    voteAttempts: 1,
    artifactObligations: { enabled: true },
    hypothesisRescue: { enabled: true },
    expandedStuckDetection: { enabled: true, alternatingPatternLength: 6, noActionTurnLimit: 3 },
    serviceSupervisor: {
      enabled: true,
      readinessTimeoutMs: 30_000,
      minimumStableMs: 1_500,
      autoRecover: true,
      maxAutoRecoveriesPerService: 1,
      crashLoopThreshold: 2,
    },
    editorGuard: { enabled: true, syntaxCheckTimeoutMs: 30_000 },
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

export const ModelRoutingConfigSchema = z
  .object({
    mainAgent: ModelRoleInputSchema.default("strong_model"),
    planner: ModelRoleInputSchema.default("main_reasoner"),
    executor: ModelRoleInputSchema.default("fast_reasoner"),
    repair: ModelRoleInputSchema.default("main_reasoner"),
    patcher: ModelRoleInputSchema.default("fast_reasoner"),
    completionGate: ModelRoleInputSchema.default("fast_reasoner"),
    summarizer: ModelRoleInputSchema.default("fast_reasoner"),
    judge: ModelRoleInputSchema.default("judge"),
  })
  .strict()
  .optional()
  .default({
    mainAgent: "strong_model",
    planner: "main_reasoner",
    executor: "fast_reasoner",
    repair: "main_reasoner",
    patcher: "fast_reasoner",
    completionGate: "fast_reasoner",
    summarizer: "fast_reasoner",
    judge: "judge",
  });

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
  })
  .strict();

export type ReaperConfig = z.infer<typeof ReaperConfigSchema>;

export function parseReaperConfig(input: unknown): ReaperConfig {
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

  if (role === "embedder" && !capabilities.embeddings) {
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
