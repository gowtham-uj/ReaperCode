/**
 * prepare.ts — shared pipeline for spawning a subagent soul.
 *
 * Returns the prepared prompt and a per-instance context snapshot
 * the runner writes back as the run progresses.
 *
 * The runner wraps the LLM gateway; the "soul" here is a lightweight
 * adapter that:
 *  - has a system prompt (persisted on first run, reused on resume)
 *  - has a tool list (filtered through ToolPolicy)
 *  - can stream events into the SubagentOutputWriter
 *  - can be told to call the model gateway to produce text
 *
 * Reaper's actual LLM gateway is provided by the runtime layer. The
 * Swarm layer only knows about the `SubagentModelFn` interface.
 */

import type { AgentTypeDefinition, AgentLaunchSpec, ToolPolicy } from "./types.js";
import { SubagentStore, readContextMessages } from "./store.js";

export interface PreparedSoul {
  systemPrompt: string;
  tools: string[];
  finalPrompt: string;
  resumed: boolean;
}

/** Compute the effective system prompt for a subagent. */
export function buildSystemPrompt(basePrompt: string, typeDef: AgentTypeDefinition): string {
  const addition = typeDef.systemPromptAddition;
  if (!addition) return basePrompt;
  return `${basePrompt}\n\n# Subagent context\n${addition}`;
}

/** Apply ToolPolicy to a parent tool list. */
export function resolveTools(policy: ToolPolicy, parentTools: string[]): string[] {
  if (policy.mode === "allowlist") {
    return policy.tools.filter((t) => parentTools.includes(t));
  }
  // inherit: start with parent's tools, remove excludes
  return parentTools.filter((t) => !policy.excludeTools.includes(t));
}

/** The model-call interface Reaper passes into the Swarm. The
 *  runtime layer implements this with its own gateway. */
export interface SubagentModelFn {
  (input: {
    agentId: string;
    systemPrompt: string;
    tools: string[];
    prompt: string;
    signal: AbortSignal;
    onEvent: (ev: WireEventLike) => void;
  }): Promise<{ text: string; turns: number; toolCalls: number; tokensUsed: number }>;
}

export type WireEventLike =
  | { kind: "stage"; name: string }
  | { kind: "tool_call"; name: string }
  | { kind: "tool_result"; status: "ok" | "error"; brief: string }
  | { kind: "text"; text: string };

/** Run the prepare pipeline. Persists the prompt and writes the
 *  system prompt to context on first run; reuses on resume. */
export function prepareSoul(input: {
  agentId: string;
  typeDef: AgentTypeDefinition;
  parentBasePrompt: string;
  parentTools: string[];
  prompt: string;
  resumed: boolean;
  store: SubagentStore;
}): PreparedSoul {
  const systemPrompt = buildSystemPrompt(input.parentBasePrompt, input.typeDef);
  const tools = resolveTools(input.typeDef.toolPolicy, input.parentTools);

  // Persist the prompt snapshot.
  input.store.writePrompt(input.agentId, input.prompt);

  return {
    systemPrompt,
    tools,
    finalPrompt: input.prompt,
    resumed: input.resumed,
  };
}

/** Read the agent's stored context messages. Used by runners to
 *  inspect what the subagent saw. NOT visible to the main agent. */
export function getStoredContext(agentId: string, store: SubagentStore): string[] {
  return readContextMessages(agentId, store);
}

/** Build an AgentLaunchSpec for a new instance. */
export function buildLaunchSpec(input: {
  agentId: string;
  subagentType: string;
  modelOverride: string | null;
  effectiveModel: string | null;
}): AgentLaunchSpec {
  return {
    agentId: input.agentId,
    subagentType: input.subagentType,
    modelOverride: input.modelOverride,
    effectiveModel: input.effectiveModel,
    createdAt: new Date().toISOString(),
  };
}
