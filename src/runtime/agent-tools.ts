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
  extensionTools: readonly AgentToolDescriptor[] = [],
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
  /*
   * Extension tools are not in `toolRegistry`, so `add` cannot reach them.
   * They are appended directly, subject to the same disabled filter, because
   * the executor will dispatch them and the model has to be offered what it
   * can call. They are not deferred: an enabled extension's tools are few and
   * a model cannot search for a name it has no other way to learn.
   */
  for (const descriptor of extensionTools) {
    if (included.has(descriptor.name)) continue;
    if (disabledTools.has(descriptor.name)) continue;
    included.add(descriptor.name);
    out.push(descriptor);
  }
  return out;
}

/**
 * Tool names a transcript depends on, read out of its own tool calls.
 *
 * A resumed conversation is a record of the model calling tools. The wire only
 * carries `CORE_TOOL_NAMES` plus whatever this run has discovered, and
 * `clearDiscoveredTools` runs at the start of every run — so a resumed thread
 * rehydrates a transcript full of calls to tools that are no longer declared.
 *
 * That mismatch is not inert. An OpenAI-compatible provider silently discards a
 * tool call naming a tool absent from the request's `tools` array, and returns
 * the finish reason with no content and no call. Reaper sees an empty stop and
 * reports "the model returned 3 empty responses in a row", which is a
 * description of the symptom and also wrong about the cause: the model answered
 * every time, and the answer was thrown away in transit.
 *
 * Feeding these names back into discovery keeps the declared surface a superset
 * of what the history actually used, which is the only thing that makes a
 * resumed transcript safe to send.
 */
export function toolNamesUsedInTranscript(messages: Iterable<unknown>): string[] {
  const names = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const calls = (message as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== "object") continue;
      const fn = (call as { function?: unknown }).function;
      const name = fn && typeof fn === "object" ? (fn as { name?: unknown }).name : undefined;
      if (typeof name === "string" && name.length > 0) names.add(name);
    }
  }
  return [...names];
}

/** Shared empty set, so the common no-tools-disabled path allocates nothing. */
export const EMPTY_TOOL_SET: ReadonlySet<string> = new Set<string>();

/** Build a single tool descriptor from the registry (for on-demand promotion). */
export function buildAgentToolDescriptor(name: string): AgentToolDescriptor | undefined {
  return descriptorFor(name);
}

/**
 * One `AgentToolDescriptor` per enabled extension tool, for the model surface.
 *
 * An extension already carries the JSON Schema it declared for its arguments, so
 * it is passed through rather than converted; a missing schema becomes an empty
 * object schema, which is what the extension registry does when it validates a
 * call. No metadata is needed here — the wire shape is name/description/schema,
 * the same as a built-in.
 */
export function extensionToolDescriptors(
  tools: { listTools(): string[]; getDefinition(name: string): { name: string; description: string; schema?: Record<string, unknown> } | undefined } | undefined,
): AgentToolDescriptor[] {
  if (!tools) return [];
  return tools.listTools().flatMap((name) => {
    const definition = tools.getDefinition(name);
    if (!definition) return [];
    return [{
      name: definition.name,
      description: definition.description,
      inputSchema: definition.schema ?? { type: "object", properties: {} },
    }];
  });
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
