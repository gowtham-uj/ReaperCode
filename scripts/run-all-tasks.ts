#!/usr/bin/env npx tsx
/**
 * Run all 5 initial tasks with Reaper agent.
 * No hardcoded plans, no hardcoded fallbacks - everything is LLM-driven.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

import { RuntimeEngine } from "../src/runtime/engine.js";
import { SmartModelRouterGateway } from "../src/model/smart-router.js";
import { LiteLLMProviderClient } from "../src/model/providers/litellm-gateway.js";
import { createLiveReaperConfig } from "../tests/fixtures/live-gateway.js";
import { createValidRequestEnvelope } from "../tests/fixtures/phase0.js";
import { getLiveLlmLogPath, writeLiveLlmLog } from "../tests/fixtures/live-llm-log.js";

const TASKS = [
  {
    id: "task1-fullstack",
    title: "Full-stack Task Management App",
    prompt: `Build a full-stack task management web application completely from scratch using any modern tech stack. The application must support user authentication, task creation, editing, deletion, filtering, persistent database storage, responsive UI, automated tests, Docker setup, and complete documentation. Plan the architecture, create the entire project structure, implement all features, debug runtime issues, and ensure the final application runs successfully end-to-end.`
  },
  {
    id: "task2-chat",
    title: "Real-time Chat Application",
    prompt: `Create a real-time chat application from scratch with frontend, backend, database, and WebSocket communication. Implement user accounts, live messaging, online status indicators, chat history persistence, reconnection handling, automated testing, containerization, and deployment configuration. The system should recover gracefully from runtime errors and maintain stable communication between multiple clients.`
  },
  {
    id: "task3-ecommerce",
    title: "E-commerce Platform",
    prompt: `Build a complete e-commerce platform from scratch including product catalog, authentication, shopping cart, checkout flow, order tracking, admin dashboard, payment simulation, database integration, API layer, frontend UI, automated tests, and deployment setup. The project should include proper architecture planning, error handling, logging, and documentation.`
  },
  {
    id: "task4-notes",
    title: "Collaborative Note-taking Platform",
    prompt: `Create a collaborative note-taking platform from scratch where multiple users can edit notes simultaneously in real time. Implement authentication, synchronization logic, persistent storage, version history, conflict handling, automated testing, responsive frontend, API backend, and production-ready Docker configuration.`
  },
  {
    id: "task5-kanban",
    title: "Kanban Project Management System",
    prompt: `Build a complete Kanban-style project management system from scratch supporting multiple workspaces, drag-and-drop boards, task assignments, due dates, comments, notifications, authentication, database persistence, automated tests, API documentation, and responsive UI. Design the entire architecture and ensure all workflows operate correctly.`
  }
];

async function setupWorkspace(root: string) {
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "reaper-task", version: "1.0.0", type: "module",
    scripts: { test: "node --test tests/*.test.js", start: "node src/server.js" }
  }, null, 2));
  execSync("git init && git add -A && git commit -m 'init' --allow-empty", {
    cwd: root, stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_NAME: "R", GIT_AUTHOR_EMAIL: "r@r.com", GIT_COMMITTER_NAME: "R", GIT_COMMITTER_EMAIL: "r@r.com" }
  });
}

async function runTask(task: typeof TASKS[0]) {
  const runId = `run-${Date.now()}-${randomUUID().slice(0,8)}`;
  const wsRoot = path.join("/workspace", "reaper_eval", "workspaces", task.id, runId);
  const logDir = path.join("/workspace", "reaper_eval", "run_logs", task.id, runId);
  
  await setupWorkspace(wsRoot);
  await mkdir(logDir, { recursive: true });

  const config = createLiveReaperConfig();
  const client = new LiteLLMProviderClient({
    onAttempt: (ev: any) => writeLiveLlmLog({
      testName: `${task.id}:${runId}`, operation: "generate_attempt",
      provider: ev.provider, model: ev.model, role: ev.role,
      request: { attempt: ev.attempt, maxAttempts: ev.maxAttempts },
      response: { ok: ev.ok, durationMs: ev.durationMs, profileName: ev.profileName },
      timestamp: new Date().toISOString()
    })
  });
  const gateway = new SmartModelRouterGateway(config, client);

  const request = createValidRequestEnvelope();
  request.connection_id = `c-${runId}`;
  request.session_id = `s-${runId}`;
  request.trace_id = `t-${runId}`;
  request.payload = { prompt: task.prompt };

  const engine = new RuntimeEngine({
    config, workspaceRoot: wsRoot, requestEnvelope: request, modelGateway: gateway
  });

  const result = await engine.run();
  const duration = Math.round((Date.now() - Date.parse(result.trajectoryPath ? "now" : new Date().toString())) / 1000);
  
  // Summary
  const summary: any = {
    taskId: task.id, title: task.title, runId,
    status: result.verification?.ok ? "passed" : "failed",
    durationMs: Date.now(),
    verification: result.verification,
    toolResults: result.toolResults?.length,
    assistantMessage: result.assistantMessage?.slice(0, 1000),
  };
  await writeFile(path.join(logDir, "summary.json"), JSON.stringify(summary, null, 2));
  
  // Count files created
  let fileCount = 0;
  try {
    const gitOut = execSync("git ls-files --others --exclude-standard 2>/dev/null | wc -l", { cwd: wsRoot, encoding: "utf8" });
    fileCount = parseInt(gitOut.trim()) || 0;
  } catch {}
  
  return { ...summary, fileCount };
}

async function main() {
  console.log("\n" + "=".repeat(80));
  console.log("REAPER AGENT - RUNNING ALL 5 INITIAL TASKS");
  console.log("=".repeat(80));

  const results: any[] = [];
  
  for (const task of TASKS) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`TASK ${task.id}: ${task.title}`);
    console.log(`${"=".repeat(80)}`);
    console.log(`Prompt: ${task.prompt.slice(0, 100)}...`);
    
    const startedAt = Date.now();
    try {
      const result = await runTask(task);
      const duration = ((Date.now() - startedAt) / 1000).toFixed(0);
      result.durationSec = parseInt(duration);
      results.push(result);
      
      const symbol = result.status === "passed" ? "✅" : "❌";
      console.log(`\n${symbol} ${task.id}: ${result.status.toUpperCase()} (${duration}s, ${result.toolResults || 0} tools, ${result.fileCount || 0} files)`);
      if (result.verification) {
        console.log(`   Verification: ${result.verification.ok ? "PASSED" : "FAILED"} (attempts: ${result.verification.attemptCount})`);
      }
    } catch (error) {
      const duration = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`\n❌ ${task.id}: ERROR after ${duration}s`);
      console.log(`   ${error instanceof Error ? error.message : String(error)}`);
      results.push({ taskId: task.id, title: task.title, status: "errored", durationSec: parseInt(duration), error: error instanceof Error ? error.message : String(error) });
    }
  }
  
  // Final report
  console.log("\n" + "=".repeat(80));
  console.log("FINAL RESULTS");
  console.log("=".repeat(80));
  const passed = results.filter(r => r.status === "passed").length;
  const failed = results.filter(r => r.status === "failed").length;
  const errored = results.filter(r => r.status === "errored").length;
  const totalTime = results.reduce((sum, r) => sum + (r.durationSec || 0), 0);
  
  for (const r of results) {
    const s = r.status === "passed" ? "✅" : r.status === "failed" ? "❌" : "💥";
    console.log(`${s} ${r.taskId}: ${r.status} (${r.durationSec || "?"}s)`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed, ${errored} errored  (${Math.round(totalTime/60)} min)`);
  
  // Save all results
  await writeFile("/workspace/reaper_eval/all-tasks-results.json", JSON.stringify(results, null, 2));
  console.log(`\nFull results: /workspace/reaper_eval/all-tasks-results.json`);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
