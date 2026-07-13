/**
 * Dependency-graph optimizer for batched tool calls.
 *
 * The scheduler in `src/execution/scheduler.ts` already parallelizes
 * reads and non-barrier shell commands in a single pool. This module
 * adds three Codex/Claude/OpenCode-style optimizations on top of
 * that pool:
 *
 * 1. **Deduplication** — multiple `read_file` calls for the same path
 *    collapse to one call. The duplicates are returned as if they
 *    were executed (each caller gets the same result), but the
 *    underlying tool only runs once.
 *
 * 2. **Concurrency cap** — the model can issue many reads in one turn
 *    (e.g. exploring 20 files). We cap how many run in parallel so
 *    we don't spawn 20 concurrent fs/network calls. Reads are still
 *    parallel, just bounded.
 *
 * 3. **Deterministic ordering** — pool results are returned in the
 *    same order as the input calls, so downstream code can rely on
 *    positional parity.
 *
 * The optimizer is a pure function over the call list; it does not
 * touch the executor. The scheduler still drives the actual execution.
 */

import type { ResourceKeys, ToolCall } from "../tools/types.js";
import { declaredResourcesForToolCall } from "../tools/resource-keys.js";
import { classifyToolCall, type ExecutionKind } from "./planner.js";

export interface OptimizationResult {
  /** Calls in the same order as the input, with duplicates kept (caller should execute the unique plan and re-attach results). */
  calls: ToolCall[];
  /**
   * The unique plan to execute: one entry per logical operation. The
   * first occurrence in `calls` is the canonical entry; later entries
   * point at the same canonical index.
   */
  uniquePlan: ToolCall[];
  /** Map from `calls` index to `uniquePlan` index. */
  uniqueIndex: number[];
  /** Concurrency cap suggested for this batch. */
  concurrency: number;
}

export interface OptimizerOptions {
  /** Maximum number of read-only calls to run in parallel. Default 8. */
  maxParallelReads?: number;
  /** Maximum number of non-barrier shell commands in parallel. Default 4. */
  maxParallelShell?: number;
}

export interface IslandCall {
  call: ToolCall;
  originalIndex: number;
  kind: ExecutionKind;
  resources: ResourceKeys;
}

export interface ExecutionIsland {
  calls: IslandCall[];
  canParallelize: boolean;
  concurrency: number;
  containsWrite: boolean;
  startsWithShellBarrier: boolean;
}

export interface IslandPartitionResult {
  islands: ExecutionIsland[];
}

/**
 * Default concurrency caps chosen to keep prompt-fan-in latency low
 * while still being friendly to file-descriptor / network-connection
 * limits. A 30-call batch is reduced to at most 8 + 4 in flight.
 */
const DEFAULT_MAX_PARALLEL_READS = 8;
const DEFAULT_MAX_PARALLEL_SHELL = 4;

export function optimizeToolCallBatch(
  calls: ToolCall[],
  options: OptimizerOptions = {},
): OptimizationResult {
  const maxParallelReads = options.maxParallelReads ?? DEFAULT_MAX_PARALLEL_READS;
  const maxParallelShell = options.maxParallelShell ?? DEFAULT_MAX_PARALLEL_SHELL;

  const uniquePlan: ToolCall[] = [];
  const seen = new Map<string, number>();
  const uniqueIndex: number[] = [];

  for (const call of calls) {
    const key = dedupKey(call);
    if (key !== undefined) {
      const existing = seen.get(key);
      if (existing !== undefined) {
        uniqueIndex.push(existing);
        continue;
      }
    }
    const planIndex = uniquePlan.length;
    uniquePlan.push(call);
    uniqueIndex.push(planIndex);
    if (key !== undefined) seen.set(key, planIndex);
  }

  // Compute the concurrency cap: at most maxParallelReads for the read
  // pool, at most maxParallelShell for the non-barrier shell pool,
  // summed (they run on independent pools). Always at least 1 so the
  // pool still makes progress when there is exactly one entry.
  const reads = uniquePlan.filter((call) => classifyToolCall(call) === "read").length;
  const nonBarrierShells = uniquePlan.filter((call) => classifyToolCall(call) === "shell_non_barrier").length;
  const readsCap = Math.min(reads, maxParallelReads);
  const shellCap = Math.min(nonBarrierShells, maxParallelShell);
  const concurrency = Math.max(1, Math.max(readsCap, shellCap));

  return {
    calls,
    uniquePlan,
    uniqueIndex,
    concurrency,
  };
}

/**
 * Return a dedup key for the call if the call is a candidate for
 * de-duplication. Reads of the same path collapse; grep_search for
 * the same pattern/path collapses; list_directory for the same path
 * collapses. Writes and shell commands do NOT collapse (they have
 * side effects that the model intended to invoke separately).
 */
function dedupKey(call: ToolCall): string | undefined {
  const args = (call.args ?? {}) as Record<string, unknown>;
  switch (call.name) {
    case "read_file":
    case "view_file":
    case "skim_file": {
      const path = typeof args.path === "string" ? args.path : undefined;
      const start = typeof args.startLine === "number" ? args.startLine : "";
      const end = typeof args.endLine === "number" ? args.endLine : "";
      return path ? `read:${call.name}:${path}:${start}:${end}` : undefined;
    }
    case "list_directory": {
      const path = typeof args.path === "string" ? args.path : undefined;
      return path ? `list_directory:${path}` : undefined;
    }
    case "grep_search": {
      const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
      const path = typeof args.path === "string" ? args.path : "";
      return pattern ? `grep:${pattern}:${path}` : undefined;
    }
    case "git_status":
      return "git_status";
    case "git_diff": {
      const path = typeof args.path === "string" ? args.path : "";
      return `git_diff:${path}`;
    }
    default:
      return undefined;
  }
}

export function partitionsForParallelExecution(
  calls: ToolCall[],
  options: OptimizerOptions = {},
): IslandPartitionResult {
  const maxParallelReads = options.maxParallelReads ?? DEFAULT_MAX_PARALLEL_READS;
  const maxParallelShell = options.maxParallelShell ?? DEFAULT_MAX_PARALLEL_SHELL;
  const islands: ExecutionIsland[] = [];
  let current: IslandCall[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const canParallelize = current.every((c) => c.resources.declared);
    const reads = current.filter((c) => c.kind === "read").length;
    const shells = current.filter((c) => c.kind === "shell_non_barrier").length;
    const writes = current.filter((c) => c.kind === "write").length;
    const concurrency = canParallelize
      ? Math.max(1, Math.min(current.length, Math.max(Math.min(reads + writes, maxParallelReads), Math.min(shells, maxParallelShell))))
      : 1;
    islands.push({
      calls: current,
      canParallelize,
      concurrency,
      containsWrite: current.some((c) => c.kind === "write"),
      startsWithShellBarrier: current[0]?.kind === "shell_barrier",
    });
    current = [];
  };

  const sharesKey = (a: IslandCall, b: IslandCall): boolean => {
    const aKeys = a.resources.keys ?? [];
    const bKeys = b.resources.keys ?? [];
    if (aKeys.length === 0 || bKeys.length === 0) return false;
    const keys = new Set(aKeys);
    return bKeys.some((key) => keys.has(key));
  };

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const kind = classifyToolCall(call);
    const resources = declaredResourcesForToolCall(call);
    const item: IslandCall = { call, originalIndex: i, kind, resources };

    if (kind === "shell_barrier") {
      flush();
      current.push(item);
      flush();
      continue;
    }

    const unsafeIntoParallel = current.some((c) => !c.resources.declared) || !resources.declared;
    const unsafeCollision = current.some(
      (candidate) =>
        sharesKey(candidate, item) &&
        (candidate.kind !== "read" || item.kind !== "read"),
    );
    if (current.length > 0 && (unsafeIntoParallel || unsafeCollision)) {
      flush();
    }
    current.push(item);
  }
  flush();
  return { islands };
}

/**
 * Re-attach deduplicated results to the original call order. Given
 * the unique-plan results in plan order, return one result per
 * original call position.
 */
export function fanoutDeduplicatedResults<T>(
  uniqueResults: T[],
  uniqueIndex: number[],
): T[] {
  const out: T[] = new Array(uniqueIndex.length);
  for (let i = 0; i < uniqueIndex.length; i += 1) {
    out[i] = uniqueResults[uniqueIndex[i]!]!;
  }
  return out;
}
