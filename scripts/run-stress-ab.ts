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

// Honor the env provider/model when set; fallback to a default
// that previously succeeded in A/B runs.
const ENV_PROVIDER = process.env["REAPER_EVAL_PROVIDER"];
const ENV_MODEL = process.env["REAPER_EVAL_MODEL"];
const ENV_SECONDARY_MODEL = process.env["REAPER_EVAL_SECONDARY_MODEL"];
const PROVIDER = ENV_PROVIDER ?? "minimax";
const MODEL = ENV_MODEL ?? "MiniMax-M3";
// The `secondary_model` sibling role is used by the OMP #21
// Promote-Context-Model layer. By default we use the same model
// name (so the swap is a no-op at the gateway level but the wiring
// still emits the trajectory event for observability). Set
// REAPER_EVAL_SECONDARY_MODEL to register a strictly different
// sibling model for an actual gateway-level swap.
const SECONDARY_MODEL = ENV_SECONDARY_MODEL ?? MODEL;

const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const WORKSPACE = `/tmp/reaper-stress-${FIXTURE_NAME}-${SOFT_CAP}-${STAMP}`;
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

// Write .reaper/config.json with the requested softCap + tunables for stress.
writeFileSync(
  path.join(WORKSPACE, ".reaper", "config.json"),
  JSON.stringify({
    tokenBudget: { softCap: SOFT_CAP },
    models: {
      default_model: {
        provider: PROVIDER,
        model: MODEL,
        apiBase: "https://api.minimax.io/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        timeoutMs: 600000,
        maxRetries: 2,
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
          maxContextTokens: 32_768,
          maxOutputTokens: 8_192,
        },
        defaultParams: { temperature: 0, maxTokens: 4096, reasoningEffort: "medium" },
      },
      // A second profile with a strictly larger context window so the
      // #21 Promote-Context-Model layer can recommend a swap to
      // this sibling when the active profile's threshold is
      // approached. MUST use a valid ModelRole enum value
      // (modelRoleValues in src/model/types.ts), so the
      // ModelsConfigSchema's strict key-set accepts it.
      //
      // Reaper v0.2 renamed `secondary_model` to `secondary_model`.
      // The schema accepts both via the alias machinery; new configs
      // should use the canonical `secondary_model` key below.
      secondary_model: {
        provider: PROVIDER,
        model: MODEL,
        apiBase: "https://api.minimax.io/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        timeoutMs: 600000,
        maxRetries: 2,
        capabilities: {
          streaming: true,
          toolCalling: true,
          jsonMode: true,
          structuredOutput: true,
          embeddings: false,
          maxContextTokens: 524_288,
          maxOutputTokens: 32_000,
        },
        defaultParams: { temperature: 0, maxTokens: 4096, reasoningEffort: "medium" },
      },
    },
    contextManagement: {
      softCap: Math.max(2000, Math.floor(SOFT_CAP * 0.5)),
      shakeTriggerPct: 20,        // trigger shake at 20% — force aggressive
      shakeProtectWindowChars: 1000,
      shakeMinSavingsChars: 30,
      maxConsecutiveShakeFailures: 3,
      ptlRecoveryMaxDrops: 5,
      ptlRecoveryMinChars: 50,
      spilloverThresholdBytes: 8000,
      spilloverPreviewChars: 800,
      timeMicrocompactEnabled: true,
      timeMicrocompactGapMs: 30_000,  // 30s for stress (real is 5 min)
      timeMicrocompactKeepRecent: 2,
      fullSummaryEnabled: true,
      fullSummaryMaxFilesToRestore: 2,
      fullSummaryFileTokenBudget: 10_000,
      fullSummaryMaxPtlRetries: 2,
      fullSummaryMinCharsForPtlDrop: 50,
      bashHeadTailEnabled: true,
      bashHeadPreviewChars: 600,
      bashTailPreviewChars: 600,
      bashPersistThresholdChars: 5_000,  // low to force head+tail on any big output
      warningThresholdRatio: 0.5,
      errorThresholdRatio: 0.7,
      blockingThresholdRatio: 0.9,
    },
    modelRouting: {
      default_model: "default_model",
      mainAgent: "default_model",
      planner: "default_model",
      executor: "default_model",
      repair: "default_model",
      patcher: "default_model",
      completionGate: "default_model",
      summarizer: "default_model",
      judge: "default_model",
    },
    runtimeTunables: {
      bashDefaultTimeoutMs: 600_000,
      bashIdleTimeoutMs: 45_000,
      // Lower the bash executor's persist threshold to match the
      // wiring's bashHeadTail threshold (5K). Without this, the
      // bash executor only persists+head-tails outputs >30K, and
      // the wiring's 5K threshold never sees a non-trivial output
      // because the executor has already pre-truncated to 2 chars.
      bashPersistThresholdChars: 5_000,
      bashPreviewSizeChars: 1_200,
      bashAssistantBlockingBudgetMs: 120_000,
      maxShellOutputBytes: 50 * 1024 * 1024,
      stallWatchdogIntervalMs: 10_000,
    },
  }, null, 2) + "\n",
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