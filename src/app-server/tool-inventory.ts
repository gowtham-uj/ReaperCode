/**
 * The tool names a thread's agent could call, for the per-thread settings UI.
 *
 * Derived from `toolRegistry` at call time rather than a hand-maintained list.
 * The registry is what the model's tool schemas are built from, so deriving
 * means the settings screen cannot offer a switch for a tool that does not
 * exist, and cannot silently miss one that was just added — the two failure
 * modes a duplicated list guarantees over time.
 */

import { buildDescriptorsFromRegistry } from "../tools/descriptor-builder.js";
import { getAllToolDescriptors } from "../tools/descriptor.js";
import { toolRegistry } from "../tools/registry.js";
import type { CapabilityTier, ToolFamily, ToolLoadMode } from "../tools/descriptor.js";

export interface ToolInventoryEntry {
  name: string;
  /** Human label derived from the name, for a settings row. */
  label: string;
  /** One-line summary; the row's secondary text. */
  summary: string;
  /**
   * "core" tools ship in every request; "discoverable" ones are listed by name
   * only until the model promotes them. Worth surfacing: disabling a core tool
   * changes what the agent can do from its first step, while disabling a
   * discoverable one mostly removes it from search results.
   */
  loadMode: ToolLoadMode;
  /** "read" / "write" / "exec" — drives the row's risk hint. */
  capabilityTier: CapabilityTier;
  family: ToolFamily;
}

export function listAgentTools(): ToolInventoryEntry[] {
  // Idempotent: builds the descriptor map on first call, no-ops afterwards.
  buildDescriptorsFromRegistry();
  const descriptors = getAllToolDescriptors();
  if (descriptors.length === 0) {
    // Descriptors should always exist after the line above; fall back to the
    // registry itself rather than answering an empty list, which would render
    // as "this agent has no tools" and hide the real problem.
    return Object.entries(toolRegistry).map(([name, entry]) => ({
      name,
      label: humanizeToolName(name),
      summary: firstSentence(entry.description),
      loadMode: "discoverable" as const,
      capabilityTier: "read" as const,
      family: "file" as const,
    }));
  }
  return descriptors
    .map((descriptor) => ({
      name: descriptor.name,
      label: descriptor.label,
      summary: descriptor.summary,
      loadMode: descriptor.loadMode,
      capabilityTier: descriptor.capabilityTier,
      family: descriptor.family,
    }))
    .sort((a, b) => {
      // Core first, then alphabetical: the tools a thread's behavior most
      // depends on stay at the top of a list that can run to a hundred rows.
      if (a.loadMode !== b.loadMode) return a.loadMode === "core" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function humanizeToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function firstSentence(description: string): string {
  const stop = description.indexOf(". ");
  const sentence = stop >= 0 ? description.slice(0, stop) : description;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}
