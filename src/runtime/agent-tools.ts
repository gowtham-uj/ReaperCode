/**
 * Static tool surface for the main agent.
 *
 * SINGLE SOURCE OF TRUTH: this module derives the model-facing
 * `AgentToolDescriptor[]` from `tools/registry.ts`. Tool descriptions
 * and argument schemas live in `toolRegistry[name] = { description,
 * argsSchema }`. We convert each core tool to an `AgentToolDescriptor`
 * via zod's JSON Schema conversion. If a tool's schema or description changes,
 * the model-facing surface updates automatically.
 *
 * No duplication. No "layered drift" between the registry and the
 * agent-facing tool list. To add a tool, add it to `toolRegistry`
 * and (if always-on) to `CORE_TOOL_NAMES`. To remove a tool from
 * the model surface, remove it from `CORE_TOOL_NAMES`. To change a
 * description, edit `toolRegistry[name].description`.
 */

import { z } from "zod";

import { toolRegistry, CORE_TOOL_NAMES, type ToolName } from "../tools/registry.js";

export interface AgentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function descriptorFor(name: string): AgentToolDescriptor | undefined {
  if (!Object.prototype.hasOwnProperty.call(toolRegistry, name)) return undefined;
  const entry = toolRegistry[name as ToolName];
  if (!entry) return undefined;
  const inputSchema = z.toJSONSchema(entry.argsSchema, {
    io: "input",
    target: "draft-7",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return {
    name,
    description: entry.description,
    inputSchema,
  };
}

/**
 * Model-facing tool list for the general agent.
 *
 * `disabledTools` removes names from the surface entirely — including from
 * `search_tools` discovery, since `ON_DEMAND_TOOL_NAMES` is derived from the
 * same set and `executeSearchTools` matches against it. Filtering here (rather
 * than only at execution) is what keeps a disabled tool from being *offered*
 * and then refused, which reads to the model as a malfunction rather than a
 * policy.
 */
export function buildGeneralAgentTools(
  additionalNames: Iterable<string> = [],
  disabledTools: ReadonlySet<string> = EMPTY_TOOL_SET,
): AgentToolDescriptor[] {
  const out: AgentToolDescriptor[] = [];
  const included = new Set<string>();
  const add = (name: string) => {
    if (included.has(name)) return;
    if (disabledTools.has(name)) return;
    const descriptor = descriptorFor(name);
    if (!descriptor) return;
    included.add(name);
    out.push(descriptor);
  };

  for (const name of CORE_TOOL_NAMES) add(name);
  for (const name of additionalNames) add(name);
  return out;
}

/** Shared empty set, so the common no-tools-disabled path allocates nothing. */
export const EMPTY_TOOL_SET: ReadonlySet<string> = new Set<string>();

/** Build a single tool descriptor from the registry (for on-demand promotion). */
export function buildAgentToolDescriptor(name: string): AgentToolDescriptor | undefined {
  return descriptorFor(name);
}

/** True when the user request explicitly mentions scratchpad usage. */
export function userPromptRequestsScratchpad(request: { payload?: { prompt?: unknown } } | unknown): boolean {
  const record = request && typeof request === "object" ? (request as Record<string, unknown>) : undefined;
  const payload = record?.payload && typeof record.payload === "object" ? (record.payload as Record<string, unknown>) : undefined;
  const prompt =
    typeof payload?.prompt === "string"
      ? payload.prompt
      : typeof record?.prompt === "string"
        ? record.prompt
        : "";
  return /\bscratchpad\b/i.test(prompt);
}
