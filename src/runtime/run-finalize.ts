/**
 * Run finalization helpers extracted from runtime/engine.ts.
 *
 * - `classifyRunFinalStatus` decides whether the final state of a run
 *   should be reported as "completed" or "failed" based on the state
 *   fields available at the end of a run.
 * - `persistRunFailure` writes the failure marker JSON when a run
 *   crashes.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReaperRunContext } from "./run-manager.js";

type GraphMode = "explicit_tools" | "needs_model" | "autonomous";
type SplitToolCalls = { completionSignal?: unknown };
type ToolResult = { ok: boolean };
type RuntimeEngineResult = {
  verification?: { ok?: boolean } | undefined;
};

export function classifyRunFinalStatus(state: {
  explicitVerification: RuntimeEngineResult["verification"] | undefined;
  mode: GraphMode | undefined;
  split?: SplitToolCalls | undefined;
  toolResults: ToolResult[] | undefined;
  completionGateExhausted?: boolean | undefined;
}): "completed" | "failed" {
  if (state.completionGateExhausted) return "failed";
  if (state.explicitVerification?.ok === false) return "failed";
  if (state.explicitVerification?.ok === true) return "completed";
  if (state.mode === "autonomous" && state.split?.completionSignal) return "completed";
  if (state.mode === "autonomous" && !state.explicitVerification?.ok) return "failed";
  if ((state.toolResults ?? []).some((item) => !item.ok)) return "failed";
  return "completed";
}

export async function persistRunFailure(runContext: ReaperRunContext, error: unknown): Promise<void> {
  await mkdir(runContext.runDir, { recursive: true });
  await writeFile(
    path.join(runContext.runDir, "result.json"),
    JSON.stringify(
      {
        runId: runContext.runId,
        sessionId: runContext.sessionId,
        traceId: runContext.traceId,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}