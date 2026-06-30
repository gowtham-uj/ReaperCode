/**
 * Args schema for the `Agent` tool — the main model's entry point
 * to delegate a single subagent run.
 *
 * The runtime resolves the subagent type from a YAML-defined
 * allowlist (default: coder, explore, plan). The subagent's
 * result is returned as a compact text block.
 */

import { z } from "zod";

export const AgentArgsSchema = z.object({
  /** Short description (3-5 words) shown in the tool list. */
  description: z.string().min(1).max(120),
  /** Full prompt to send to the subagent. */
  prompt: z.string().min(1),
  /** Subagent type from the YAML allowlist. Defaults to "coder". */
  subagent_type: z.string().min(1).optional(),
  /** Model alias override. */
  model: z.string().min(1).nullable().optional(),
  /** Resume an existing subagent by agent_id. */
  resume: z.string().min(1).nullable().optional(),
  /** Run in the background. */
  run_in_background: z.boolean().optional(),
  /** Per-call timeout in seconds. null = no timeout. */
  timeout: z.number().int().nonnegative().nullable().optional(),
});

export type AgentArgs = z.infer<typeof AgentArgsSchema>;
