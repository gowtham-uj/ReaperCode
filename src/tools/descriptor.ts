/**
 * tools/descriptor.ts — Phase 0 skeleton for the tool descriptor layer.
 *
 * A ToolDescriptor wraps each registered tool with metadata that drives:
 * - BM25 discovery indexing (Phase 2)
 * - Tool-family-based concurrency partitioning
 * - Context-cost-aware tool selection
 * - Capability-tier-based access control
 *
 * This module is intentionally additive scaffolding in Phase 0.
 * It does not touch the existing registry or executor; later phases
 * will generate descriptors from the registry and consume them.
 */

import type z from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a tool is loaded into the model's per-turn context. */
export type ToolLoadMode = "core" | "discoverable";

/** Semantic family for concurrency partitioning and discovery grouping. */
export type ToolFamily =
  | "file"
  | "search"
  | "edit"
  | "shell"
  | "job"
  | "diagnostic"
  | "web"
  | "memory"
  | "exec";

/** What kind of side effect the tool has. */
export type CapabilityTier = "read" | "write" | "exec";

/** Concurrency behavior. Shared = safe to parallelize; exclusive = serialize. */
export type ToolConcurrency = "shared" | "exclusive";

/** Rough token cost of the tool's schema + description in context. */
export type ContextCost = "low" | "medium" | "high";

/**
 * Rich metadata around a registered tool.
 *
 * Phase 0: type only, no generation logic yet.
 * Phase 1: generated from the existing `toolRegistry`.
 * Phase 2: indexed by BM25 discovery.
 */
export interface ToolDescriptor {
  /** Canonical tool name (must match toolRegistry key). */
  readonly name: string;
  /** Human-friendly label for TUI / docs. */
  readonly label: string;
  /** One-line summary used in the deferred tool list. */
  readonly summary: string;
  /** Full description (copied from toolRegistry entry). */
  readonly description: string;
  /** Zod schema for argument validation. */
  readonly argsSchema: z.ZodType;
  /** Whether the tool is always-on (core) or discoverable. */
  readonly loadMode: ToolLoadMode;
  /** Semantic family. */
  readonly family: ToolFamily;
  /** What the tool does to the workspace. */
  readonly capabilityTier: CapabilityTier;
  /** Whether this tool can run in parallel with others of the same family. */
  readonly concurrency: ToolConcurrency;
  /** Rough context token cost. */
  readonly contextCost: ContextCost;
  /** Alternative names the model might use (for discovery). */
  readonly aliases: readonly string[];
  /** Example invocations for BM25 indexing. */
  readonly examples: readonly string[];
  /** Where this tool comes from (builtin, extension, etc.). */
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Skeleton registry (Phase 0: empty; Phase 1 will populate)
// ---------------------------------------------------------------------------

/**
 * A lazy map of tool name → ToolDescriptor.
 * Phase 0: this is an empty scaffold. Phase 1 will generate it from
 * `toolRegistry` via `buildDescriptorsFromRegistry()`.
 */
const _descriptorMap = new Map<string, ToolDescriptor>();

/**
 * Look up a descriptor by tool name.
 * Returns `undefined` if no descriptor has been registered.
 */
export function getToolDescriptor(name: string): ToolDescriptor | undefined {
  return _descriptorMap.get(name);
}

/**
 * Register a descriptor. Phase 1 will call this for every tool in the registry.
 */
export function registerToolDescriptor(descriptor: ToolDescriptor): void {
  _descriptorMap.set(descriptor.name, descriptor);
}

/**
 * Get all registered descriptors. Phase 2's BM25 indexer will use this.
 */
export function getAllToolDescriptors(): readonly ToolDescriptor[] {
  return Array.from(_descriptorMap.values());
}
