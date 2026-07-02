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
type ToolResult = {
  ok: boolean;
  name?: string;
  args?: unknown;
};
type RuntimeEngineResult = {
  verification?: { ok?: boolean } | undefined;
};

type VerifierKind = "build" | "test";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function verifierKind(result: ToolResult): VerifierKind | undefined {
  if (result.name !== "bash") return undefined;
  const args = asRecord(result.args);
  const cmd = typeof args?.cmd === "string" ? args.cmd : undefined;
  if (!cmd) return undefined;
  if (/\b(pnpm|npm|yarn)\b[^\n;|&]*\b(test|vitest|jest)\b/.test(cmd)) return "test";
  if (/\b(pnpm|npm|yarn)\b[^\n;|&]*\b(build|tsc)\b/.test(cmd)) return "build";
  return undefined;
}

function hasUnrecoveredVerifierFailure(toolResults: ToolResult[]): boolean {
  const failed = new Set<VerifierKind>();
  for (const result of toolResults) {
    const kind = verifierKind(result);
    if (!kind) continue;
    if (result.ok) failed.delete(kind);
    else failed.add(kind);
  }
  return failed.size > 0;
}

export function classifyRunFinalStatus(state: {
  explicitVerification?: RuntimeEngineResult["verification"];
  mode: GraphMode | undefined;
  split?: SplitToolCalls | undefined;
  toolResults: ToolResult[] | undefined;
  completionGateExhausted?: boolean | undefined;
}): "completed" | "failed" {
  if (state.completionGateExhausted) return "failed";
  if (state.explicitVerification?.ok === false) return "failed";
  if (state.explicitVerification?.ok === true) return "completed";
  if (state.mode === "autonomous" && state.split?.completionSignal) return "completed";
  // autonomous run with an empty assistant message is not a real completion
  if (state.mode === "autonomous" && !state.explicitVerification?.ok) {
    // If the last tool result succeeded and at least one tool result exists,
    // treat this as the autonomous natural-stop case and accept it as
    // completed even without an explicit verification verdict. Intermediate
    // !ok results during autonomous recovery (e.g. test fail → fix → test
    // pass) are part of normal model-driven debugging and must not flip the
    // run to "failed" when the model ultimately succeeded.
    const toolResults = state.toolResults ?? [];
    if (hasUnrecoveredVerifierFailure(toolResults)) return "failed";
    if (toolResults.length > 0 && toolResults[toolResults.length - 1]?.ok !== false) {
      return "completed";
    }
    return "failed";
  }
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