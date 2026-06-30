import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ScoredRunSet {
  root: string;
  resultCount: number;
  passed: number;
  failed: number;
  passRate: number;
  timeoutRate: number;
  medianToolCalls: number;
  maxToolCalls: number;
  medianIdenticalRepeat: number;
  maxIdenticalRepeat: number;
  noProgressStops: number;
  harnessTimeouts: number;
  infraFailures: number;
}

interface ResultRecord {
  key: string;
  isResolved: boolean;
  timedOut: boolean;
  infraFailed: boolean;
}

interface MetricsRecord {
  totalToolCalls: number;
  maxActionRepeat: number;
  stopReason?: string | undefined;
}

const TARGET_FILENAMES = new Set(["results.json", "trajectory-metrics.json", "reaper-trajectory.jsonl", "reaper-terminal-bench-result.json"]);
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", "sessions", "artifacts", "recordings"]);

export async function scoreRunSet(root: string): Promise<ScoredRunSet> {
  const files = await collectTargetFiles(root);
  const results = new Map<string, ResultRecord>();
  const metrics: MetricsRecord[] = [];
  let bridgeTimeouts = 0;
  let bridgeInfraFailures = 0;

  for (const file of files) {
    const name = path.basename(file);
    if (name === "results.json") {
      for (const record of await readResultRecords(file)) {
        results.set(record.key, record);
      }
    } else if (name === "trajectory-metrics.json") {
      const record = await readTrajectoryMetrics(file);
      if (record) metrics.push(record);
    } else if (name === "reaper-trajectory.jsonl") {
      metrics.push(...(await readTrajectorySessionMetrics(file)));
    } else if (name === "reaper-terminal-bench-result.json") {
      const bridge = await readBridgeResult(file);
      if (bridge?.timedOut) bridgeTimeouts += 1;
      if (bridge?.infraFailed) bridgeInfraFailures += 1;
    }
  }

  const resultList = [...results.values()];
  const passed = resultList.filter((record) => record.isResolved).length;
  const timeoutCount = resultList.filter((record) => record.timedOut).length + bridgeTimeouts;
  const infraFailures = resultList.filter((record) => record.infraFailed).length + bridgeInfraFailures;
  const toolCalls = metrics.map((record) => record.totalToolCalls).filter(Number.isFinite);
  const repeats = metrics.map((record) => record.maxActionRepeat).filter(Number.isFinite);
  const noProgressStops = metrics.filter((record) => record.stopReason === "no_progress_stop").length;
  const harnessTimeouts = metrics.filter((record) => record.stopReason === "harness_timeout").length + bridgeTimeouts;

  return {
    root,
    resultCount: resultList.length,
    passed,
    failed: Math.max(0, resultList.length - passed),
    passRate: ratio(passed, resultList.length),
    timeoutRate: ratio(timeoutCount, Math.max(resultList.length, timeoutCount)),
    medianToolCalls: median(toolCalls),
    maxToolCalls: max(toolCalls),
    medianIdenticalRepeat: median(repeats),
    maxIdenticalRepeat: max(repeats),
    noProgressStops,
    harnessTimeouts,
    infraFailures,
  };
}

export function formatScore(summary: ScoredRunSet): string {
  const lines = [
    `Run set: ${summary.root}`,
    `Results: ${summary.resultCount} (${summary.passed} passed, ${summary.failed} failed)`,
    `Pass rate: ${formatPercent(summary.passRate)}`,
    `Timeout rate: ${formatPercent(summary.timeoutRate)}`,
    `Tool calls: median=${summary.medianToolCalls} max=${summary.maxToolCalls}`,
    `Identical action repeat: median=${summary.medianIdenticalRepeat} max=${summary.maxIdenticalRepeat}`,
    `Stop split: no_progress_stop=${summary.noProgressStops} harness_timeout=${summary.harnessTimeouts} infra_failed=${summary.infraFailures}`,
  ];
  return lines.join("\n");
}

async function collectTargetFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile() && TARGET_FILENAMES.has(entry.name)) {
        output.push(fullPath);
      }
    }
  }
  await walk(root);
  return output;
}

async function readResultRecords(file: string): Promise<ResultRecord[]> {
  const json = await readJson(file);
  const maybeSuite = json && typeof json === "object" ? (json as { results?: unknown }) : {};
  const rawRecords: unknown[] = Array.isArray(maybeSuite.results) ? maybeSuite.results : [json];
  return rawRecords
    .filter((record): record is Record<string, unknown> => Boolean(record && typeof record === "object" && typeof (record as Record<string, unknown>).is_resolved === "boolean"))
    .map((record) => ({
      key: String(record.trial_name ?? record.id ?? `${record.task_id ?? "result"}:${file}`),
      isResolved: Boolean(record.is_resolved),
      timedOut: Boolean(record.timed_out ?? record.timedOut ?? /timeout/i.test(String(record.failure_mode ?? ""))),
      infraFailed: /infra/i.test(String(record.failure_mode ?? record.status ?? "")),
    }));
}

async function readTrajectoryMetrics(file: string): Promise<MetricsRecord | undefined> {
  const json = await readJson(file);
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;
  return {
    totalToolCalls: numberField(record.total_tool_calls) ?? numberField(record.tool_count) ?? 0,
    maxActionRepeat: numberField(record.max_action_repeat) ?? numberField(record.max_identical_repeat) ?? 0,
    stopReason: typeof record.stop_reason === "string" ? record.stop_reason : undefined,
  };
}

async function readTrajectorySessionMetrics(file: string): Promise<MetricsRecord[]> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const output: MetricsRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.kind !== "session_metrics") continue;
      output.push({
        totalToolCalls: numberField(record.total_tool_calls) ?? numberField(record.tool_count) ?? 0,
        maxActionRepeat: numberField(record.max_action_repeat) ?? 0,
        stopReason: typeof record.stop_reason === "string" ? record.stop_reason : undefined,
      });
    } catch {
      continue;
    }
  }
  return output;
}

async function readBridgeResult(file: string): Promise<{ timedOut: boolean; infraFailed: boolean } | undefined> {
  const json = await readJson(file);
  if (!json || typeof json !== "object") return undefined;
  const record = json as Record<string, unknown>;
  const failureClass = String(record.failureClass ?? record.failure_class ?? record.status ?? "");
  return {
    timedOut: Boolean(record.timedOut ?? record.timed_out) || /timeout/i.test(failureClass),
    infraFailed: /infra/i.test(failureClass),
  };
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  return JSON.parse(text);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function max(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    console.error("Usage: node --import tsx scripts/score_runs.ts <run-set-dir>");
    process.exitCode = 2;
    return;
  }
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    console.error(`Run-set directory not found: ${root}`);
    process.exitCode = 2;
    return;
  }
  console.log(formatScore(await scoreRunSet(root)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
