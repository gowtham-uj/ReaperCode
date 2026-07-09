import { z } from "zod";

export const BashInputSchema = z
  .object({
    command: z.string().min(1).describe("Shell command to run in the workspace"),
    description: z.string().min(1).optional().describe("Short human-readable intent (shown in summaries)"),
    // REQUIRED: per-command timeout in SECONDS (matching the
    // model-facing schema in src/tools/types.ts and the reference-agent
    // pattern, e.g. pi-mono). 1 second ≤ value ≤ 3600 seconds
    // (1 hour). There is NO DEFAULT TIMEOUT — the model must
    // pass an explicit value. If the model emits a bash call
    // without `timeout`, the schema validation will fail and the
    // call will return a clear error to the model, not a silent
    // 60-second timeout.
    timeout: z
      .number()
      .int()
      .min(1)
      .max(3600)
      .describe(
        "REQUIRED. Per-command timeout in SECONDS (1-3600). " +
        "There is no default timeout; you must pass an explicit value. " +
        "Use 60 for short probes, 300 for builds/installs/tests, " +
        "larger for long-running jobs. The model is expected to pass this on every call.",
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
