import type { RecoverySession } from "../recovery/session.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { optimizeToolCallBatch } from "./optimizer.js";
import { classifyToolCall } from "./planner.js";

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
  let pool: ToolCall[] = [];
  let barrierFlushed = false;
  let pendingWriteResultIndexes: number[] = [];
  let flushedWriteResultIndexes: number[] = [];

  const flushPool = async (): Promise<boolean> => {
    if (pool.length === 0) {
      return false;
    }

    // Apply the dependency-graph optimizer to the current pool: dedup
    // identical reads/greps, and respect a concurrency cap so the
    // model cannot accidentally spawn unbounded parallel fs/network
    // calls. The pool's `pool.length` is the user's intent; the unique
    // plan is what we actually execute.
    const optimization = optimizeToolCallBatch(pool);
    const uniqueResults = await executeConcurrent(
      optimization.uniquePlan,
      executor,
      optimization.concurrency,
    );
    const poolResults = fanoutToOriginalOrder(uniqueResults, optimization.uniqueIndex, pool);
    results.push(...poolResults);
    pool = [];
    return poolResults.some((result) => !result.ok);
  };

  for (const call of toolCalls) {
    if (abortSignal?.aborted) {
      await recoverySession.abort("Execution aborted by signal");
      return { results, aborted: true };
    }

    const kind = classifyToolCall(call);
    if (kind === "read" || kind === "shell_non_barrier") {
      pool.push(call);
      continue;
    }

    if (await flushPool()) {
      return { results, aborted: false };
    }

    if (kind === "write") {
      // Flush the read/non-barrier pool first so its results are
      // visible to the model. The previous code skipped this on
      // early-return paths, dropping the read results on the floor
      // and leaving any side effects (e.g. from shell_non_barrier)
      // unsnapshotted.
      const poolResults = await flushPool();
      if (poolResults) {
        return { results, aborted: false };
      }
      const result = withToolCallId(await executor.execute(call), call);
      results.push(result);
      if (!result.ok) {
        const cause = result.error?.message ?? `Tool call ${call.id} failed`;
        await recoverySession.rollback(cause);
        markRolledBack(results, pendingWriteResultIndexes, cause);
        return { results, aborted: false };
      }
      pendingWriteResultIndexes.push(results.length - 1);
      continue;
    }

    if (kind === "shell_barrier") {
      const poolResults = await flushPool();
      if (poolResults) {
        return { results, aborted: false };
      }
      if (recoverySession.hasPendingWrites()) {
        await recoverySession.flushForBarrier();
        barrierFlushed = true;
        flushedWriteResultIndexes = [...flushedWriteResultIndexes, ...pendingWriteResultIndexes];
        pendingWriteResultIndexes = [];
      }

      const result = withToolCallId(await executor.execute(call), call);
      results.push(result);
      if (!result.ok) {
        // Failed build/test/runtime checks are diagnostic feedback for the next
        // agent step. Preserve preceding edits so the model can inspect and
        // repair the actual attempted state instead of chasing rolled-back files.
        return { results, aborted: false };
      }
    }
  }

  if (await flushPool()) {
    return { results, aborted: false };
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
        const result = withToolCallId(await executor.execute(call), call);
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
    .sort((a, b) => (a.completedAt !== b.completedAt ? (a.completedAt < b.completedAt ? -1 : 1) : a.index - b.index))
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
