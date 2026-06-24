/**
 * Improved Reaper Task Runner for Task 2 (Real-time Chat Application).
 * 
 * Features:
 * - Phase-based execution (probe → plan → implement → verify → fix)
 * - Web research for dependency/solution discovery
 * - Proper verification feedback loop
 * - Progress tracking with REAPER_MEMORY.md
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { RuntimeEngine } from "../src/runtime/engine.js";
import { SmartModelRouterGateway } from "../src/model/smart-router.js";
import { LiteLLMProviderClient } from "../src/model/providers/litellm-gateway.js";
import { createLiveReaperConfig } from "../tests/fixtures/live-gateway.js";
import { createValidRequestEnvelope } from "../tests/fixtures/phase0.js";
import { getLiveLlmLogPath, writeLiveLlmLog } from "../tests/fixtures/live-llm-log.js";

// ===== Task 2: Real-time Chat Application =====
const TASK = {
  id: "initial-task-2-improved",
  title: "Real-time Chat Application",
  prompt: `Create a real-time chat application from scratch with frontend, backend, database, and WebSocket communication. Implement user accounts, live messaging, online status indicators, chat history persistence, reconnection handling, automated testing, containerization, and deployment configuration. The system should recover gracefully from runtime errors and maintain stable communication between multiple clients.`,
  verificationCommand: "npm test"
};

async function main() {
  const runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const workspaceRoot = path.join("/workspace", "reaper_eval", "workspaces", TASK.id, runId);
  const logRoot = path.join("/workspace", "reaper_eval", "run_logs", TASK.id, runId);

  // Clean workspace
  await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(logRoot, { recursive: true });
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  // Seed minimal workspace
  const seedFiles = {
    "src/app.ts": "// Real-time Chat Application - Entry Point\n",
    "README.md": "# Real-time Chat Application\n\nBuilding a real-time chat application with WebSocket communication.\n",
    "package.json": JSON.stringify({
      name: "realtime-chat-app",
      version: "1.0.0",
      type: "module",
      scripts: {
        test: "node --test tests/**/*.test.ts",
        build: "tsc",
        start: "node dist/server.js",
        dev: "tsx src/server.ts"
      }
    }, null, 2)
  };

  for (const [relPath, content] of Object.entries(seedFiles)) {
    const targetPath = path.join(workspaceRoot, relPath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }

  // Initialize git repository (required for some engine operations)
  await new Promise((resolve, reject) => {
    execSync('git init', { cwd: workspaceRoot });
    execSync('git add -A', { cwd: workspaceRoot });
    execSync('git commit -m "Initial seed" --allow-empty', { cwd: workspaceRoot, env: { ...process.env, GIT_AUTHOR_NAME: 'Reaper', GIT_AUTHOR_EMAIL: 'reaper@test.com', GIT_COMMITTER_NAME: 'Reaper', GIT_COMMITTER_EMAIL: 'reaper@test.com' } });
    resolve(undefined);
  });

  // Enable step analysis
  process.env.REAPER_ENABLE_STEP_ANALYSIS = "1";

  // Create request envelope
  const request = createValidRequestEnvelope();
  request.connection_id = `eval-conn-${runId}`;
  request.session_id = `eval-session-${runId}`;
  request.turn_id = `eval-turn-${runId}`;
  request.request_id = `eval-request-${runId}`;
  request.trace_id = `eval-trace-${runId}`;
  request.timestamp = new Date().toISOString();
  request.payload = {
    prompt: TASK.prompt,
    verification: {
      command: TASK.verificationCommand,
      maxIterations: 3,
      allowJudgeRetry: true,
    },
  };
  request.metadata = {
    source: "reaper_eval",
    task_id: TASK.id,
    run_id: runId,
  };

  // Create model config with proper routing
  const config = createLiveReaperConfig();

  // Create gateway with logging
  const client = new LiteLLMProviderClient({
    onAttempt: (event) =>
      writeLiveLlmLog({
        testName: `eval:${TASK.id}:${runId}`,
        operation: event.operation === "stream" ? "stream_attempt" : event.operation === "embed" ? "embed_attempt" : "generate_attempt",
        provider: event.provider,
        model: event.model,
        role: event.role,
        request: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retrying: event.retrying,
        },
        response: {
          ok: event.ok,
          durationMs: event.durationMs,
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.error ? { error: event.error } : {}),
          profileName: event.profileName,
        },
        timestamp: new Date().toISOString(),
      }),
  });

  const gateway = new SmartModelRouterGateway(config, client, {
    onRoute: (event) =>
      writeLiveLlmLog({
        testName: `eval:${TASK.id}:${runId}`,
        operation: "route_decision",
        provider: "",
        model: event.selectedModel,
        role: event.role,
        request: {
          strategy: event.strategy,
          reason: event.reason,
        },
        response: {
          profileName: event.selectedProfile,
          latencyMs: event.latencyMs ?? null,
        },
        timestamp: new Date().toISOString(),
      }),
  });

  console.log(`\n${"=".repeat(70)}`);
  console.log(`REAPER AGENT - IMPROVED RUN`);
  console.log(`Task: ${TASK.title}`);
  console.log(`Run ID: ${runId}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Log: ${logRoot}`);
  console.log(`${"=".repeat(70)}\n`);

  const startedAt = Date.now();

  try {
    const engine = new RuntimeEngine({
      config,
      workspaceRoot,
      requestEnvelope: request,
      modelGateway: gateway,
    });

    const result = await engine.run();
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log(`\n${"=".repeat(70)}`);
    console.log(`RUN COMPLETE (${duration}s)`);
    console.log(`${"=".repeat(70)}`);

    // Determine final status
    const passed = result.verification?.ok === true;
    const toolCount = result.toolResults?.length || 0;
    const failureCount = result.toolResults?.filter(r => !r.ok).length || 0;

    console.log(`\nRESULTS:`);
    console.log(`  Status:       ${passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Tool Calls:   ${toolCount} (${failureCount} failed)`);
    console.log(`  Verification: ${result.verification ? (result.verification.ok ? '✅ Passed' : '❌ Failed') : '⚠️ Not run'}`);
    console.log(`  Attempts:     ${result.verification?.attemptCount || 0}`);

    // Save results
    const summary = {
      taskId: TASK.id,
      title: TASK.title,
      runId,
      durationMs: Date.now() - startedAt,
      status: passed ? "passed" : "failed",
      verification: result.verification,
      toolResults: result.toolResults?.map(r => ({
        name: r.name,
        ok: r.ok,
        durationMs: r.durationMs,
        error: r.error?.message?.slice(0, 200),
      })),
      assistantMessage: result.assistantMessage?.slice(0, 2000),
    };

    await writeFile(
      path.join(logRoot, "summary.json"),
      JSON.stringify(summary, null, 2)
    );
    await writeFile(
      path.join(logRoot, "assistant_message.txt"),
      result.assistantMessage || "(no message)"
    );

    // Print assistant message
    console.log(`\nFINAL SUMMARY:`);
    console.log(result.assistantMessage?.slice(0, 1500) || "(no summary)");
    console.log(`\n${"=".repeat(70)}`);

    if (!passed && result.verification?.feedback) {
      console.log(`\nVERIFICATION FEEDBACK:`);
      for (const fb of result.verification.feedback) {
        console.log(`  - ${fb.slice(0, 300)}`);
      }
    }

    // Print what files were created
    console.log(`\nFILES CREATED/MODIFIED:`);
    try {
      const { execSync } = await import("node:child_process");
      const gitStatus = execSync("git status --short", { cwd: workspaceRoot, encoding: "utf8" });
      console.log(gitStatus || "(none)");
    } catch {
      console.log("(could not list files)");
    }

    console.log(`\nFull logs saved to: ${logRoot}`);

  } catch (error) {
    const duration = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`\n❌ RUN FAILED after ${duration}s:`);
    console.error(error instanceof Error ? error.message : String(error));

    await writeFile(
      path.join(logRoot, "error.txt"),
      error instanceof Error ? error.stack || error.message : String(error)
    );
    process.exitCode = 1;
  }
}

main().catch(console.error);
