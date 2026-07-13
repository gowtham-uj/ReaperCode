import { z } from "zod";

import { BudgetStateSchema } from "./budget-state.js";
import { VerificationStateSchema } from "./verification-state.js";

export const RepoInspectionSchema = z
  .object({
    packageManagers: z.array(z.string()),
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    testCommands: z.array(z.string()),
    buildCommands: z.array(z.string()),
    lintCommands: z.array(z.string()),
    entrypoints: z.array(z.string()),
    configFiles: z.array(z.string()),
    importantDirectories: z.array(z.string()),
    gitStatus: z.string(),
    risks: z.array(z.string()),
  })
  .strict();

export const RuntimeStateSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    turnId: z.string().min(1),
    logLevel: z.enum(["info", "debug", "trace"]),
    safetyProfile: z.enum(["allow_all", "standard", "strict"]),
    noticeVerbosity: z.enum(["minimal", "normal", "verbose"]),
    sessionProtocolVersion: z.literal(1),
    userIntentSummary: z.string().min(1),
    tokenBudget: z
      .object({
        softCap: z.number().int().positive(),
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .strict(),
    epicState: z
      .object({
        objectives: z.array(z.string().min(1)),
      })
      .strict(),
    feedback: z.array(z.string()),
    negativeConstraints: z.array(z.string()),
    repoInspection: RepoInspectionSchema.optional(),
    /** Named-session journal key (.reaper/sessions/<name>.jsonl) for cross-run continuity. */
    namedSession: z.string().min(1).max(128).optional(),
    verificationState: VerificationStateSchema.optional(),
    budgetState: BudgetStateSchema.optional(),
  })
  .strict();

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type RuntimeRepoInspection = z.infer<typeof RepoInspectionSchema>;
export type RuntimeVerificationState = z.infer<typeof VerificationStateSchema>;
export type RuntimeBudgetState = z.infer<typeof BudgetStateSchema>;

export function parseRuntimeState(input: unknown): RuntimeState {
  return RuntimeStateSchema.parse(input);
}
