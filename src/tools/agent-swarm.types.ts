/**
 * Args schema for the `AgentSwarm` tool — the main model's entry
 * point to fan out a task to many subagents in parallel.
 *
 * Each entry of `items` is substituted into `prompt_template` at the
 * `{{item}}` placeholder, producing one subagent per item. The whole
 * set runs in parallel (bounded by max_concurrency).
 */

import { z } from "zod";

export const AgentSwarmArgsSchema = z.object({
  /** Short description (3-5 words) shown in the tool list. */
  description: z.string().min(1).max(120),
  /** Subagent type applied to every subagent in the swarm. */
  subagent_type: z.string().min(1).optional(),
  /** Template containing exactly one `{{item}}` placeholder. */
  prompt_template: z.string().min(1),
  /** Each element launches one subagent. 1..128 items. */
  items: z.array(z.string().min(1)).min(1).max(128),
  /** Model alias override applied to every subagent. */
  model: z.string().min(1).nullable().optional(),
  /** Per-subagent wall timeout in seconds. */
  timeout: z.number().int().nonnegative().nullable().optional(),
  /** Bounded concurrency (1..32). Defaults to the tool's default. */
  max_concurrency: z.number().int().min(1).max(32).optional(),
});

export type AgentSwarmArgs = z.infer<typeof AgentSwarmArgsSchema>;
