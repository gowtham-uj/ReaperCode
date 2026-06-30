#!/usr/bin/env npx tsx
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { createLiveReaperConfig } from "../tests/fixtures/live-gateway.js";
import { createValidRequestEnvelope } from "../tests/fixtures/phase0.js";
import { RuntimeEngine } from "../src/runtime/engine.js";
import { SmartModelRouterGateway } from "../src/model/smart-router.js";
import { LiteLLMProviderClient } from "../src/model/providers/litellm-gateway.js";
import { getLiveLlmLogPath, writeLiveLlmLog } from "../tests/fixtures/live-llm-log.js";

const TASK_PROMPT = "Create a real-time chat application from scratch with frontend, backend, database, and WebSocket communication. Implement user accounts, live messaging, online status indicators, chat history persistence, reconnection handling, automated testing, containerization, and deployment configuration. The system should recover gracefully from runtime errors and maintain stable communication between multiple clients.";

async function main() {
  const runId = `run-${Date.now()}-${randomUUID().slice(0,8)}`;
  const wsRoot = path.join("/workspace", "reaper_eval", "workspaces", "task2", runId);
  const logDir = path.join("/workspace", "reaper_eval", "run_logs", "task2", runId);
  
  await rm(wsRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(wsRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(path.join(wsRoot, "src"), { recursive: true });
  await mkdir(path.join(wsRoot, "public"), { recursive: true });
  await mkdir(path.join(wsRoot, "tests"), { recursive: true });

  await writeFile(path.join(wsRoot, "package.json"), JSON.stringify({
    name: "realtime-chat", version: "1.0.0", type: "module",
    scripts: { test: "node --test tests/*.test.js", start: "node src/server.js" }
  }, null, 2));

  execSync("git init && git add -A && git commit -m 'init' --allow-empty", {
    cwd: wsRoot,
    env: { ...process.env, GIT_AUTHOR_NAME: "R", GIT_AUTHOR_EMAIL: "r@r.com", GIT_COMMITTER_NAME: "R", GIT_COMMITTER_EMAIL: "r@r.com" }
  });

  const config = createLiveReaperConfig();
  const client = new LiteLLMProviderClient({
    onAttempt: (ev: any) => writeLiveLlmLog({
      testName: `task2:${runId}`, operation: "generate_attempt",
      provider: ev.provider, model: ev.model, role: ev.role,
      request: { attempt: ev.attempt, maxAttempts: ev.maxAttempts, retrying: ev.retrying },
      response: { ok: ev.ok, durationMs: ev.durationMs, profileName: ev.profileName },
      timestamp: new Date().toISOString()
    })
  });
  const gateway = new SmartModelRouterGateway(config, client);

  const request = createValidRequestEnvelope();
  request.connection_id = `c-${runId}`;
  request.session_id = `s-${runId}`;
  request.trace_id = `t-${runId}`;
  request.payload = { prompt: TASK_PROMPT };

  console.log("\n=== Reaper Agent: Task 2 ===");
  console.log(`Workspace: ${wsRoot}`);
  console.log(`Logs: ${logDir}\n`);

  const engine = new RuntimeEngine({
    config, workspaceRoot: wsRoot, requestEnvelope: request, modelGateway: gateway
  });

  const result = await engine.run();
  const duration = ((Date.now() - Date.now()) / 1000).toFixed(1);

  console.log("\n=== RESULTS ===");
  console.log(`Status: ${result.verification?.ok ? "PASSED" : "FAILED"}`);
  console.log(`Tool calls: ${result.toolResults?.length || 0}`);
  console.log(`Verification: ${JSON.stringify(result.verification)}`);
  
  // List files created
  try {
    const git = execSync("git status --short", { cwd: wsRoot, encoding: "utf8" });
    console.log("\nFiles created/modified:\n" + git);
  } catch {}

  // Save summary
  await writeFile(path.join(logDir, "summary.json"), JSON.stringify({
    runId, status: result.verification?.ok ? "passed" : "failed",
    verification: result.verification,
    assistantMessage: result.assistantMessage?.slice(0, 2000),
    toolResults: result.toolResults?.length,
    durationMs: Date.now()
  }, null, 2));
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
