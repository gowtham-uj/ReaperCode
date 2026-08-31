/**
 * Drive a Codex-style frontend consumer against a live Reaper app-server.
 *
 * Uses a deterministic fake turn runner so this does not need provider keys.
 *
 *   npx tsx scripts/mock-app-server-frontend.ts
 */
import { startAppServer } from "../src/app-server/server.js";
import type { ManagedTurnRunner } from "../src/app-server/managed-turn-runner.js";
import type { RuntimeEngineResult } from "../src/runtime/engine.js";
import { MockAppServerFrontend } from "../tests/fixtures/mock-app-server-frontend.js";
import { createTempWorkspace } from "../tests/fixtures/workspace.js";

function engineResult(message: string): RuntimeEngineResult {
  return {
    assistantMessage: message,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

function now(): string {
  return new Date().toISOString();
}

const runner: ManagedTurnRunner = async (input) => {
  await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: now() });
  await input.eventSink({ type: "assistant.reasoning.delta", text: "checking files", timestamp: now() });
  await input.eventSink({ type: "assistant.reasoning.completed", text: "checking files", timestamp: now() });
  await input.eventSink({ type: "assistant.message.delta", text: "Listed README.md. ", timestamp: now() });
  await input.eventSink({
    type: "tool.started",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } },
    timestamp: now(),
  });
  await input.eventSink({
    type: "command.output.delta",
    toolCallId: "bash-1",
    stream: "stdout",
    text: "README.md\n",
    timestamp: now(),
  });
  await input.eventSink({
    type: "tool.completed",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } },
    result: { name: "bash", toolCallId: "bash-1", ok: true, durationMs: 3, output: { stdout: "README.md\n", exitCode: 0 } },
    timestamp: now(),
  });
  await input.eventSink({ type: "assistant.message.delta", text: "Done.", timestamp: now() });
  await input.eventSink({ type: "assistant.message.completed", text: "Listed README.md. Done.", timestamp: now() });
  await input.eventSink({
    type: "turn.completed",
    runId: input.turnId,
    sessionId: input.threadId,
    assistantMessage: "Listed README.md. Done.",
    timestamp: now(),
  });
  return engineResult("Listed README.md. Done.");
};

async function main(): Promise<void> {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const ui = await MockAppServerFrontend.connect(server.ready.url, { name: "mock-ui" });
  try {
    await ui.initialize();
    await ui.waitForMethod("initialized");
    await ui.startThread({ threadId: "mock-ui-session", title: "Frontend mock" });
    await ui.startTurn({
      threadId: "mock-ui-session",
      input: [{ type: "text", text: "Look around and summarize" }],
    });
    await ui.waitForTurnCompleted("mock-ui-session");
    const turns = await ui.listTurns("mock-ui-session");
    process.stdout.write(`${ui.renderTranscript("mock-ui-session")}\n`);
    process.stdout.write(`server turns=${JSON.stringify(turns.result?.data, null, 2)}\n`);
    process.stdout.write(`methods=${ui.methods.join(" -> ")}\n`);
  } finally {
    ui.close();
    await server.stop();
  }
}

await main();
