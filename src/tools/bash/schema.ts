import { z } from "zod";

export const BashInputSchema = z
  .object({
    command: z.string().min(1).describe("Shell command to run in the workspace"),
    description: z.string().min(1).optional().describe("Short human-readable intent (shown in summaries)"),
    // Per-command timeout in SECONDS. Preserve the historical 60-second
    // default for callers that omit it while allowing longer explicit limits.
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .optional()
      .describe(
        "Optional per-command timeout in SECONDS (1-3600); defaults to 60. " +
        "Use 300 for builds/installs/tests and a larger value for long-running jobs.",
      ),
    run_in_background: z.boolean().optional().describe("Run as a background task (servers, blocking operations)"),
  })
  .strict();

export type BashInput = z.infer<typeof BashInputSchema>;

export const BashOutputSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().nullable(),
  interrupted: z.boolean(),
  persisted_output_path: z.string().optional(),
  persisted_output_size: z.number().optional(),
  background_task_id: z.string().optional(),
  /** True when the inline preview includes the head of the full output. */
  head_available: z.boolean().optional(),
  /** True when the inline preview includes the tail of the full output. */
  tail_available: z.boolean().optional(),
});

export type BashOutput = z.infer<typeof BashOutputSchema>;
