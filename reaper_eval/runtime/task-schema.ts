/**
 * reaper_eval/runtime/task-schema.ts — EvalTask v1 schema.
 *
 * Unified task shape for implementation benches and context-engineering
 * stress. Success is always gate-based (shell exit, file markers,
 * trajectory events, scratchpad/memory presence).
 */

import { z } from "zod";

export const EvalGateSchema = z.enum([
  "verification_exit_0",
  "file_equals",
  "file_contains",
  "file_exists",
  "trajectory_kind",
  "scratchpad_contains",
  "summary_exists",
  "model_calls_min",
  "system_prompt_stable_after_summary",
]);

export const EvalFileEqualsGateSchema = z
  .object({
    type: z.literal("file_equals"),
    path: z.string().min(1),
    equals: z.string(),
  })
  .strict();

export const EvalFileContainsGateSchema = z
  .object({
    type: z.literal("file_contains"),
    path: z.string().min(1),
    contains: z.string().min(1),
  })
  .strict();

export const EvalFileExistsGateSchema = z
  .object({
    type: z.literal("file_exists"),
    path: z.string().min(1),
  })
  .strict();

export const EvalTrajectoryKindGateSchema = z
  .object({
    type: z.literal("trajectory_kind"),
    kind: z.string().min(1),
    minCount: z.number().int().nonnegative().default(1),
  })
  .strict();

export const EvalScratchpadContainsGateSchema = z
  .object({
    type: z.literal("scratchpad_contains"),
    contains: z.string().min(1),
  })
  .strict();

export const EvalSummaryExistsGateSchema = z
  .object({
    type: z.literal("summary_exists"),
    minCount: z.number().int().positive().default(1),
  })
  .strict();

export const EvalModelCallsMinGateSchema = z
  .object({
    type: z.literal("model_calls_min"),
    minCount: z.number().int().positive().default(1),
  })
  .strict();

export const EvalSystemPromptStableAfterSummaryGateSchema = z
  .object({
    type: z.literal("system_prompt_stable_after_summary"),
  })
  .strict();

export const EvalVerificationExitGateSchema = z
  .object({
    type: z.literal("verification_exit_0"),
    command: z.string().min(1).optional(),
  })
  .strict();

export const EvalGateSpecSchema = z.discriminatedUnion("type", [
  EvalVerificationExitGateSchema,
  EvalFileEqualsGateSchema,
  EvalFileContainsGateSchema,
  EvalFileExistsGateSchema,
  EvalTrajectoryKindGateSchema,
  EvalScratchpadContainsGateSchema,
  EvalSummaryExistsGateSchema,
  EvalModelCallsMinGateSchema,
  EvalSystemPromptStableAfterSummaryGateSchema,
]);

export const EvalTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    suite: z.enum(["implementation", "context-days", "legacy", "custom"]).default("custom"),
    difficulty: z.enum(["easy", "medium", "hard", "stress"]).default("medium"),
    language: z.string().default("javascript"),
    /** User prompt sent to the agent. */
    prompt: z.string().min(1),
    /** Optional softCap override for context stress. */
    softCap: z.number().int().positive().optional(),
    /** Embedded project files staged into a temp workspace. */
    projectFiles: z.record(z.string()).default({}),
    /** Optional path under benchmarks/ to copy as the workspace payload. */
    fixtureDir: z.string().optional(),
    /** Primary verification shell command (also used by verification_exit_0 gate). */
    verification: z
      .object({
        command: z.string().min(1),
        maxIterations: z.number().int().positive().default(8),
      })
      .strict(),
    /** Success gates evaluated after the run. ALL must pass. */
    gates: z.array(EvalGateSpecSchema).min(1),
    /** Optional notes for humans reading the task. */
    notes: z.string().optional(),
  })
  .strict();

export type EvalTask = z.infer<typeof EvalTaskSchema>;
export type EvalGateSpec = z.infer<typeof EvalGateSpecSchema>;

export function parseEvalTask(input: unknown): EvalTask {
  return EvalTaskSchema.parse(input);
}
