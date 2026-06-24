import type { RecoverySession } from "../recovery/session.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
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

    const completionResults = await executeConcurrent(pool, executor);
    results.push(...completionResults);
    pool = [];
    return completionResults.some((result) => !result.ok);
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

async function executeConcurrent(pool: ToolCall[], executor: ToolExecutor): Promise<ToolResult[]> {
  const settled = await Promise.all(
    pool.map(async (call, index) => {
      const result = withToolCallId(await executor.execute(call), call);
      return {
        result,
        index,
        completedAt: process.hrtime.bigint(),
      };
    }),
  );

  return settled
    .sort((a, b) => (a.completedAt !== b.completedAt ? (a.completedAt < b.completedAt ? -1 : 1) : a.index - b.index))
    .map((entry) => entry.result);
}

function withToolCallId(result: ToolResult, call: ToolCall): ToolResult {
  return result.toolCallId ? result : { ...result, toolCallId: call.id };
}
