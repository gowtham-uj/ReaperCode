/**
 * reaper_eval/runtime/scorer.ts — post-run success gates.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { EvalGateSpec, EvalTask } from "./task-schema.js";

export interface GateResult {
  type: string;
  passed: boolean;
  details: Record<string, unknown>;
}

export interface ScoreContext {
  workspaceRoot: string;
  runId: string;
  trajectoryPath?: string;
  verification: { exitCode: number; stdout: string; stderr: string; command: string };
}

export async function scoreTask(task: EvalTask, ctx: ScoreContext): Promise<{
  passed: boolean;
  gates: GateResult[];
}> {
  const gates: GateResult[] = [];
  for (const gate of task.gates) {
    gates.push(await evaluateGate(gate, task, ctx));
  }
  return { passed: gates.every((g) => g.passed), gates };
}

async function evaluateGate(gate: EvalGateSpec, task: EvalTask, ctx: ScoreContext): Promise<GateResult> {
  switch (gate.type) {
    case "verification_exit_0": {
      const command = gate.command ?? task.verification.command;
      return {
        type: gate.type,
        passed: ctx.verification.exitCode === 0,
        details: {
          command,
          exitCode: ctx.verification.exitCode,
          stdoutTail: ctx.verification.stdout.slice(-2000),
          stderrTail: ctx.verification.stderr.slice(-2000),
        },
      };
    }
    case "file_equals": {
      const abs = path.join(ctx.workspaceRoot, gate.path);
      if (!existsSync(abs)) {
        return { type: gate.type, passed: false, details: { path: gate.path, error: "missing" } };
      }
      const body = await readFile(abs, "utf8");
      return {
        type: gate.type,
        passed: body === gate.equals,
        details: { path: gate.path, expectedChars: gate.equals.length, actualChars: body.length },
      };
    }
    case "file_contains": {
      const abs = path.join(ctx.workspaceRoot, gate.path);
      if (!existsSync(abs)) {
        return { type: gate.type, passed: false, details: { path: gate.path, error: "missing" } };
      }
      const body = await readFile(abs, "utf8");
      return {
        type: gate.type,
        passed: body.includes(gate.contains),
        details: { path: gate.path, needle: gate.contains },
      };
    }
    case "file_exists": {
      const abs = path.join(ctx.workspaceRoot, gate.path);
      return {
        type: gate.type,
        passed: existsSync(abs),
        details: { path: gate.path },
      };
    }
    case "trajectory_kind": {
      const counts = await countTrajectoryKinds(ctx.trajectoryPath);
      const count = counts.get(gate.kind) ?? 0;
      return {
        type: gate.type,
        passed: count >= gate.minCount,
        details: { kind: gate.kind, count, minCount: gate.minCount },
      };
    }
    case "scratchpad_contains": {
      const abs = path.join(ctx.workspaceRoot, ".reaper", "memory", "scratch.md");
      if (!existsSync(abs)) {
        return { type: gate.type, passed: false, details: { error: "scratchpad missing" } };
      }
      const body = await readFile(abs, "utf8");
      return {
        type: gate.type,
        passed: body.includes(gate.contains),
        details: { needle: gate.contains, bytes: body.length },
      };
    }
    case "summary_exists": {
      const dir = path.join(ctx.workspaceRoot, ".reaper", "summaries");
      let count = 0;
      try {
        const files = await readdir(dir);
        count = files.filter((f) => f.endsWith(".md")).length;
      } catch {
        count = 0;
      }
      return {
        type: gate.type,
        passed: count >= gate.minCount,
        details: { count, minCount: gate.minCount },
      };
    }
    case "model_calls_min": {
      const dir = path.join(ctx.workspaceRoot, ".reaper", "runs", ctx.runId, "model-calls");
      let count = 0;
      try {
        const files = await readdir(dir);
        count = files.filter((f) => f.endsWith(".txt") && f !== "TRANSCRIPT.md").length;
      } catch {
        count = 0;
      }
      return {
        type: gate.type,
        passed: count >= gate.minCount,
        details: { count, minCount: gate.minCount },
      };
    }
    case "system_prompt_stable_after_summary":
      return evaluateSystemPromptStability(ctx);
    default: {
      const exhaustive: never = gate;
      return { type: "unknown", passed: false, details: { gate: exhaustive } };
    }
  }
}

async function countTrajectoryKinds(trajectoryPath: string | undefined): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!trajectoryPath || !existsSync(trajectoryPath)) return counts;
  const raw = await readFile(trajectoryPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as { kind?: string };
      if (typeof obj.kind === "string") {
        counts.set(obj.kind, (counts.get(obj.kind) ?? 0) + 1);
      }
    } catch {
      /* skip bad lines */
    }
  }
  return counts;
}

async function evaluateSystemPromptStability(ctx: ScoreContext): Promise<GateResult> {
  const type = "system_prompt_stable_after_summary";
  if (!ctx.trajectoryPath || !existsSync(ctx.trajectoryPath)) {
    return { type, passed: false, details: { error: "trajectory missing" } };
  }

  let firstSummaryAt = Number.POSITIVE_INFINITY;
  const trajectory = await readFile(ctx.trajectoryPath, "utf8");
  for (const line of trajectory.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { kind?: unknown; timestamp?: unknown };
      if (event.kind !== "full_summary" || typeof event.timestamp !== "string") continue;
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp)) firstSummaryAt = Math.min(firstSummaryAt, timestamp);
    } catch {
      /* skip malformed trajectory rows */
    }
  }
  if (!Number.isFinite(firstSummaryAt)) {
    return { type, passed: false, details: { error: "no timestamped full_summary event" } };
  }

  const modelCallDir = path.join(ctx.workspaceRoot, ".reaper", "runs", ctx.runId, "model-calls");
  let files: string[] = [];
  try {
    files = (await readdir(modelCallDir)).filter((file) => /^\d+-(?:stream|generate)\.json$/.test(file)).sort();
  } catch {
    return { type, passed: false, details: { error: "model-call directory missing" } };
  }

  let baselineSystem: string | undefined;
  let calls = 0;
  let postSummaryCalls = 0;
  let mismatches = 0;
  let missingSystems = 0;
  for (const file of files) {
    try {
      const record = JSON.parse(await readFile(path.join(modelCallDir, file), "utf8")) as {
        role?: unknown;
        request?: { system?: unknown; source?: unknown; role?: unknown };
        startedAt?: unknown;
      };
      // The model-call directory also contains judge and other auxiliary
      // requests. They intentionally have no main-agent system prompt and
      // must not count as prompt-loss failures.
      if (
        (typeof record.request?.source === "string" && record.request.source !== "main_agent") ||
        (record.request?.source === undefined && (record.role === "judge" || record.request?.role === "judge"))
      ) {
        continue;
      }
      const system = record.request?.system;
      if (typeof system !== "string" || system.length === 0) {
        missingSystems += 1;
        continue;
      }
      calls += 1;
      baselineSystem ??= system;
      if (system !== baselineSystem) mismatches += 1;
      if (typeof record.startedAt === "string" && Date.parse(record.startedAt) > firstSummaryAt) {
        postSummaryCalls += 1;
      }
    } catch {
      missingSystems += 1;
    }
  }

  return {
    type,
    passed: Boolean(baselineSystem) && calls > 0 && postSummaryCalls > 0 && mismatches === 0 && missingSystems === 0,
    details: {
      calls,
      postSummaryCalls,
      mismatches,
      missingSystems,
      baselineChars: baselineSystem?.length ?? 0,
    },
  };
}
