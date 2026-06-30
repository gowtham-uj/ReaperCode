#!/usr/bin/env npx tsx
import { randomUUID } from "crypto";
import { mkdir, writeFile, rm } from "fs/promises";
import { execSync } from "child_process";
import path from "path";
import { RuntimeEngine } from "../src/runtime/engine.js";
import { SmartModelRouterGateway } from "../src/model/smart-router.js";
import { LiteLLMProviderClient } from "../src/model/providers/litellm-gateway.js";
import { createLiveReaperConfig } from "../tests/fixtures/live-gateway.js";
import { createValidRequestEnvelope } from "../tests/fixtures/phase0.js";

async function run(task: { id: string; title: string; prompt: string }) {
  const runId = "run-" + Date.now() + "-" + randomUUID().slice(0, 8);
  const wsRoot = path.join("/workspace/reaper_eval/workspaces", task.id, runId);
  const logDir = path.join("/workspace/reaper_eval/run_logs", task.id, runId);
  await rm(wsRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(wsRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(wsRoot, "package.json"),
    JSON.stringify({ name: "task", version: "1.0.0", type: "module", scripts: { test: "node --test tests/*.test.js" } }, null, 2)
  );
  execSync("git init && git add -A && git commit -m init --allow-empty", {
    cwd: wsRoot, stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "R", GIT_AUTHOR_EMAIL: "r@r.com", GIT_COMMITTER_NAME: "R", GIT_COMMITTER_EMAIL: "r@r.com" }
  });

  // Set env before config creation
  process.env.REAPER_LIVE_MODEL_TIMEOUT_MS = "300000";
  process.env.REAPER_LIVE_MODEL_MAX_RETRIES = "1";
  const config = createLiveReaperConfig();
  config.models.default_model.maxRetries = 1;
  config.models.default_model.timeoutMs = 300000;

  const client = new LiteLLMProviderClient({ onAttempt: () => {} });
  const gateway = new SmartModelRouterGateway(config, client);
  const req = createValidRequestEnvelope();
  req.connection_id = "c-" + runId;
  req.session_id = "s-" + runId;
  req.trace_id = "t-" + runId;
  req.payload = { prompt: task.prompt };

  const engine = new RuntimeEngine({ config, workspaceRoot: wsRoot, requestEnvelope: req, modelGateway: gateway });
  const result = await engine.run();
  const status = result.verification?.ok ? "PASSED" : "FAILED";
  console.log(`${task.id}: ${status} (tools=${result.toolResults?.length} verify=${result.verification?.ok ? "PASS" : "FAIL"})`);
  await writeFile(path.join(logDir, "summary.json"), JSON.stringify({ status, verification: result.verification }, null, 2));
}

const TASKS = [
  { id: "task3-ecommerce", title: "E-commerce", prompt: "Build a complete e-commerce platform from scratch including product catalog, authentication, shopping cart, checkout flow, order tracking, admin dashboard, payment simulation, database integration, API layer, frontend UI, automated tests, and deployment setup." },
  { id: "task4-notes", title: "Collab Notes", prompt: "Create a collaborative note-taking platform from scratch where multiple users can edit notes simultaneously in real time. Implement authentication, synchronization logic, persistent storage, version history, conflict handling, automated testing, responsive frontend, API backend, and production-ready Docker configuration." },
];

async function main() {
  for (const task of TASKS) {
    console.log(`\n=== ${task.id} ===`);
    const start = Date.now();
    let lastError: any;
    for (let attempt = 1; attempt >= 1; attempt++) {
      try {
        await run(task);
        break;
      } catch (e: any) {
        lastError = e;
        console.log(`  Attempt ${attempt} failed: ${e.message?.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    if (lastError) console.log(`  ERROR: ${lastError.message?.slice(0, 200)}`);
    console.log(`  Duration: ${((Date.now() - start) / 60).toFixed(1)} min`);
  }
}
main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
