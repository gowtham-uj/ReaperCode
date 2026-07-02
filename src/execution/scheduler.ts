import type { RecoverySession } from "../recovery/session.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { optimizeToolCallBatch, partitionsForParallelExecution } from "./optimizer.js";

export interface ScheduledExecutionResult {
  results: ToolResult[];
  aborted: boolean;
}

export async function executeToolCalls(
  toolCalls: ToolCall[],
  executor: ToolExecutor,
  recoverySession: RecoverySession,
  abortSignal?: AbortSignal,
): Promise<ScheduledExecutionResult> {
  const results: ToolResult[] = [];
  let pendingWriteResultIndexes: number[] = [];

  const partition = partitionsForParallelExecution(toolCalls);
  for (const island of partition.islands) {
    if (abortSignal?.aborted) {
      await recoverySession.abort("Execution aborted by signal");
      return { results, aborted: true };
    }

    if (island.startsWithShellBarrier && recoverySession.hasPendingWrites()) {
      await recoverySession.flushForBarrier();
      pendingWriteResultIndexes = [];
    }

    const islandCalls = island.calls.map((entry) => entry.call);
    const optimization = optimizeToolCallBatch(islandCalls);
    const uniqueResults = island.canParallelize
      ? await executeConcurrent(optimization.uniquePlan, executor, island.concurrency)
      : await executeSerial(optimization.uniquePlan, executor);
    const islandResults = fanoutToOriginalOrder(uniqueResults, optimization.uniqueIndex, islandCalls);
    const resultBaseIndex = results.length;
    results.push(...islandResults);

    if (island.containsWrite) {
      pendingWriteResultIndexes.push(...range(resultBaseIndex, islandResults.length));
    }

    // Do not hard-stop a model turn because one tool failed. Reference-agent
    // semantics require every tool call the model emitted to receive the real
    // tool result/error so the model can decide how to recover. The scheduler
    // only controls safe ordering/concurrency; it must not synthesize failures,
    // suppress later calls, or reshape the model's working loop.
  }

  if (abortSignal?.aborted) {
    await recoverySession.abort("Execution aborted by signal");
    return { results, aborted: true };
  }

  if (recoverySession.hasPendingWrites()) {
    await recoverySession.flushFinal();
  }

  return { results, aborted: false };
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, offset) => start + offset);
}

async function executeSerial(pool: ToolCall[], executor: ToolExecutor): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const call of pool) {
    out.push(await executeOne(call, executor));
  }
  return out;
}

async function executeOne(call: ToolCall, executor: ToolExecutor): Promise<ToolResult> {
  try {
    return withToolCallId(await executor.execute(call), call);
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    return {
      name: call.name,
      toolCallId: call.id,
      ok: false as const,
      output: "",
      durationMs: 0,
      error: { message, code: "executor_threw" },
    };
  }
}

function markRolledBack(results: ToolResult[], indexes: number[], cause: string): void {
  for (const index of indexes) {
    const result = results[index];
    if (!result || !result.ok) continue;
    results[index] = {
      ...result,
      ok: false,
      error: {
        code: "rolled_back_due_to_batch_failure",
        message: `This write was rolled back and is not present on disk. Cause: ${cause}. Re-read affected files or recreate missing files before continuing.`,
      },
      output: {
        ...(result.output && typeof result.output === "object" ? result.output : {}),
        rolledBack: true,
        rollbackCause: cause,
      },
    };
  }
}

async function executeConcurrent(
  pool: ToolCall[],
  executor: ToolExecutor,
  concurrency: number = pool.length,
): Promise<ToolResult[]> {
  if (pool.length === 0) return [];
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, pool.length));
  const settled: Array<{ result: ToolResult; index: number; completedAt: bigint }> = [];
  let cursor = 0;
  // Bounded-concurrency runner: a small semaphore ensures we never
  // have more than `effectiveConcurrency` in-flight promises, and
  // `await Promise.all` waits for *all* of them to finish — not just
  // the first. This avoids the "spawn 50 reads in parallel" pathology
  // without losing any results.
  let inFlight = 0;
  const pending: Array<Promise<void>> = [];
  const launchNext = () => {
    if (cursor >= pool.length) return;
    const index = cursor;
    const call = pool[index]!;
    cursor += 1;
    inFlight += 1;
    const p = (async () => {
      try {
        const result = await executeOne(call, executor);
        settled.push({ result, index, completedAt: process.hrtime.bigint() });
      } finally {
        inFlight -= 1;
      }
    })();
    pending.push(p);
  };
  for (let i = 0; i < effectiveConcurrency; i += 1) launchNext();
  while (cursor < pool.length || inFlight > 0) {
    if (cursor < pool.length && inFlight < effectiveConcurrency) {
      launchNext();
      continue;
    }
    if (pending.length > 0) {
      await Promise.all(pending.splice(0, pending.length).map((p) => p.then(() => undefined)));
    } else {
      // Defensive: avoid an infinite loop if pending is empty but
      // something is still considered in-flight.
      break;
    }
  }
  // Drain any straggler promises.
  if (pending.length > 0) {
    await Promise.all(pending.splice(0, pending.length).map((p) => p.then(() => undefined)));
  }
  return settled
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.result);
}

/**
 * Re-attach unique-plan results to the original call list, in the
 * original order. Duplicates get the canonical entry's result.
 */
function fanoutToOriginalOrder(
  uniqueResults: ToolResult[],
  uniqueIndex: number[],
  originalPool: ToolCall[],
): ToolResult[] {
  if (uniqueResults.length === uniqueIndex.length && uniqueResults.length === originalPool.length) {
    return uniqueResults;
  }
  const out: ToolResult[] = new Array(originalPool.length);
  for (let i = 0; i < originalPool.length; i += 1) {
    const planIdx = uniqueIndex[i]!;
    out[i] = uniqueResults[planIdx]!;
  }
  return out;
}

function withToolCallId(result: ToolResult, call: ToolCall): ToolResult {
  return result.toolCallId ? result : { ...result, toolCallId: call.id };
}
