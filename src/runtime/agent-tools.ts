/**
 * Static tool surface for the main coding agent.
 *
 * SINGLE SOURCE OF TRUTH: this module derives the model-facing
 * `AgentToolDescriptor[]` from `tools/registry.ts`. Tool descriptions
 * and argument schemas live in `toolRegistry[name] = { description,
 * argsSchema }`. We convert each core tool to an `AgentToolDescriptor`
 * via `zodToJsonSchema`. If a tool's schema or description changes,
 * the model-facing surface updates automatically.
 *
 * No duplication. No "layered drift" between the registry and the
 * agent-facing tool list. To add a tool, add it to `toolRegistry`
 * and (if always-on) to `CORE_TOOL_NAMES`. To remove a tool from
 * the model surface, remove it from `CORE_TOOL_NAMES`. To change a
 * description, edit `toolRegistry[name].description`.
 */

import { zodToJsonSchema } from "zod-to-json-schema";

import { toolRegistry, CORE_TOOL_NAMES, type ToolName } from "../tools/registry.js";

export interface AgentToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildGeneralAgentTools(): AgentToolDescriptor[] {
  const out: AgentToolDescriptor[] = [];
  for (const name of CORE_TOOL_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(toolRegistry, name)) continue;
    const entry = toolRegistry[name as ToolName];
    if (!entry) continue;
    // Convert the zod schema to JSON Schema. `toolRegistry[name].argsSchema`
    // is the single source of truth for what the model must emit.
    const inputSchema = zodToJsonSchema(entry.argsSchema, {
      $refStrategy: "none",
      target: "jsonSchema7",
    }) as Record<string, unknown>;
    out.push({
      name,
      description: entry.description,
      inputSchema,
    });
  }
  return out;
}
