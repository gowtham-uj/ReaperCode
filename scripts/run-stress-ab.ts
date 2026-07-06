#!/usr/bin/env tsx
/**
 * scripts/run-stress-ab.ts — A/B smoke runner for Reaper context management.
 *
 * Usage:
 *   node scripts/run-stress-ab.ts <fixture-name> <softCap>
 *
 * Examples:
 *   node scripts/run-stress-ab.ts read-then-act-mid-compact 270000
 *   node scripts/run-stress-ab.ts reread-huge-file 500000
 *   node scripts/run-stress-ab.ts bash-giant-log-spillover 1000000
 *
 * What it does:
 *   1. Sets up a per-run workspace at /tmp/reaper-stress-<fixture>-<softCap>-<timestamp>
 *   2. Writes a .reaper/config.json with the requested softCap
 *   3. Copies the fixture's payload/ + task_prompt.md into the workspace
 *   4. Runs `npx tsx scripts/run-reaper.ts exec run ...` against MiniMax-M3
 *   5. Captures the trajectory, run-result, shake events, spillover artifacts
 *   6. Prints a one-page summary with assertable metrics
 *
 * Why MiniMax-M3: the catalog `minimax-oauth` model. softCap from .reaper/config.json
 * overrides the model's natural cap so we can simulate 270K / 500K / 1M.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const REPO = "/workspace/reapercode-main";
const FIXTURE_NAME = process.argv[2] ?? "read-then-act-mid-compact";
const SOFT_CAP = Number(process.argv[3] ?? "270000");

if (!SOFT_CAP || SOFT_CAP < 1000) {
  console.error(`Invalid softCap: ${SOFT_CAP} (must be >= 1000)`);
  process.exit(2);
}

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const WORKSPACE = `/tmp/reaper-stress-${FIXTURE_NAME}-${SOFT_CAP}-${STAMP}`;
const PROVIDER = "minimax-oauth";
const MODEL = "MiniMax-M3";
const FIXTURE_PATH = path.join(REPO, "benchmarks", FIXTURE_NAME);

if (!existsSync(FIXTURE_PATH)) {
  console.error(`Fixture not found: ${FIXTURE_PATH}`);
  process.exit(2);
}

console.log(`Fixture: ${FIXTURE_NAME}`);
console.log(`softCap: ${SOFT_CAP}`);
console.log(`Workspace: ${WORKSPACE}`);

// Set up workspace.
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(path.join(WORKSPACE, ".reaper"), { recursive: true });

// Write .reaper/config.json with the requested softCap.
writeFileSync(
  path.join(WORKSPACE, ".reaper", "config.json"),
  JSON.stringify({ tokenBudget: { softCap: SOFT_CAP } }, null, 2) + "\n",
);

// Copy payload + task_prompt.md.
execFileSync("cp", ["-R", path.join(FIXTURE_PATH, "payload"), WORKSPACE], { stdio: "inherit" });
execFileSync("cp", [path.join(FIXTURE_PATH, "task_prompt.md"), WORKSPACE], { stdio: "inherit" });

// Run Reaper.
const promptFile = path.join(WORKSPACE, "task_prompt.md");
const resultFile = path.join(WORKSPACE, "reaper-result.json");
console.log(`\nRunning Reaper...`);
let runFailed = false;
try {
  execFileSync(
    "npx",
    [
      "tsx",
      "scripts/run-reaper.ts",
      "exec",
      "run",
      "--workspace", WORKSPACE,
      "--provider", PROVIDER,
      "--model", MODEL,
      "--prompt-file", promptFile,
      "--json",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] },
  );
} catch (err) {
  runFailed = true;
  console.error(`Run failed: ${(err).message?.slice(0, 200)}`);
}

// Locate the most recent run directory.
const runsDir = path.join(WORKSPACE, ".reaper", "runs");
let runDir = null;
if (existsSync(runsDir)) {
  const runs = readdirSync(runsDir).map((n) => path.join(runsDir, n));
  runs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  runDir = runs[0] ?? null;
}

if (!runDir) {
  console.error(`\nNo run dir found under ${runsDir}`);
  process.exit(1);
}

console.log(`\nRun dir: ${runDir}`);

// Analyze the trajectory.
const trajPath = path.join(runDir, "logs", "reaper-trajectory.jsonl");
const traj = existsSync(trajPath)
  ? readFileSync(trajPath, "utf8").split(/\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean)
  : [];

// Count shake events + extract aggregate stats.
const shakeEvents = traj.filter((e) => e?.kind === "context_shake");
const toolCallEvents = traj.filter((e) => e?.kind === "tool_call");
const totalShaken = shakeEvents.reduce((s, e) => s + (e.shaken_results ?? 0), 0);
const totalSavedChars = shakeEvents.reduce((s, e) => s + (e.saved_chars ?? 0), 0);

// Count tool call names.
const toolCounts = {};
for (const e of toolCallEvents) {
  if (!e.tool_name) continue;
  toolCounts[e.tool_name] = (toolCounts[e.tool_name] ?? 0) + 1;
}

// Count spillover artifacts.
const spilloverDir = path.join(WORKSPACE, ".reaper", "spillover");
const spilloverFiles = existsSync(spilloverDir) ? readdirSync(spilloverDir) : [];

const resultPath = path.join(runDir, "result.json");
const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : null;

// Final summary.
console.log(`\n${"=".repeat(64)}`);
console.log(`Stress A/B summary`);
console.log(`${"=".repeat(64)}`);
console.log(`status:           ${result?.status ?? "unknown"}${runFailed ? " (run process exited non-zero)" : ""}`);
console.log(`assistantMessage: ${(result?.assistantMessage ?? "").slice(0, 200)}${(result?.assistantMessage?.length ?? 0) > 200 ? "..." : ""}`);
console.log(`toolResultCount:  ${result?.toolResultCount ?? "n/a"}`);
console.log(`failedToolResults: ${result?.failedToolResultCount ?? "n/a"}`);
console.log(`durationMs:       ${result?.durationMs ?? "n/a"}`);
console.log("");
console.log(`shakeEvents:      ${shakeEvents.length}`);
console.log(`totalShaken:      ${totalShaken}`);
console.log(`totalSavedChars:  ${totalSavedChars.toLocaleString()}`);
console.log("");
console.log(`toolCallCounts:`);
for (const [name, count] of Object.entries(toolCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(20)} ${count}`);
}
console.log("");
console.log(`spilloverArtifacts: ${spilloverFiles.length}`);
for (const f of spilloverFiles.slice(0, 5)) {
  const sz = Number(statSync(path.join(spilloverDir, f)).size);
  console.log(`  ${f} (${sz.toLocaleString()} bytes)`);
}
if (spilloverFiles.length > 5) {
  console.log(`  ... ${spilloverFiles.length - 5} more`);
}
console.log(`${"=".repeat(64)}`);

process.exit(runFailed ? 2 : 0);