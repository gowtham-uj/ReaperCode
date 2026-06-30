import { z } from "zod";

export const BashInputSchema = z
  .object({
    command: z.string().min(1).describe("Shell command to run in the workspace"),
    description: z.string().min(1).optional().describe("Short human-readable intent (shown in summaries)"),
    timeout: z.number().int().min(1).max(600_000).optional().describe("Per-command timeout in milliseconds"),
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
});

export type BashOutput = z.infer<typeof BashOutputSchema>;
