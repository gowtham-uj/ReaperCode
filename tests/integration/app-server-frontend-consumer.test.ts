import test from "node:test";
import assert from "node:assert/strict";

import { startAppServer } from "../../src/app-server/server.js";
import type { ManagedTurnRunner, ManagedTurnRunnerInput } from "../../src/app-server/managed-turn-runner.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import { MockAppServerFrontend } from "../fixtures/mock-app-server-frontend.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

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

const richRunner: ManagedTurnRunner = async (input) => {
  const emit = async (event: Parameters<ManagedTurnRunnerInput["eventSink"]>[0]) => {
    await input.eventSink(event);
  };
  await emit({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: now() });
  await emit({ type: "assistant.reasoning.delta", text: "inspecting workspace", timestamp: now() });
  await emit({ type: "assistant.reasoning.completed", text: "inspecting workspace", timestamp: now() });
  await emit({ type: "assistant.message.delta", text: "I'll list files, then write a note.", timestamp: now() });
  await emit({
    type: "tool.started",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } },
    timestamp: now(),
  });
  await emit({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: "README.md\n", timestamp: now() });
  await emit({
    type: "tool.completed",
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } },
    result: { name: "bash", toolCallId: "bash-1", ok: true, durationMs: 4, output: { stdout: "README.md\n", exitCode: 0 } },
    timestamp: now(),
  });
  await emit({
    type: "tool.started",
    toolCall: { id: "write-1", name: "write_file", args: { path: "note.txt", content: "ok" } },
    timestamp: now(),
  });
  await emit({
    type: "tool.completed",
    toolCall: { id: "write-1", name: "write_file", args: { path: "note.txt", content: "ok" } },
    result: { name: "write_file", toolCallId: "write-1", ok: true, durationMs: 2, output: { path: "note.txt" } },
    timestamp: now(),
  });
  await emit({
    type: "tool.started",
    toolCall: { id: "search-1", name: "web_search", args: { query: "reaper app server" } },
    timestamp: now(),
  });
  await emit({
    type: "tool.completed",
    toolCall: { id: "search-1", name: "web_search", args: { query: "reaper app server" } },
    result: { name: "web_search", toolCallId: "search-1", ok: true, durationMs: 8, output: { hits: 3 } },
    timestamp: now(),
  });
  await emit({ type: "verification.started", command: "node --test", timestamp: now() });
  await emit({ type: "verification.completed", ok: true, command: "node --test", summary: "pass", timestamp: now() });
  await emit({ type: "compaction.updated", phase: "started", timestamp: now() });
  await emit({ type: "compaction.updated", phase: "completed", savedChars: 120, timestamp: now() });
  await emit({ type: "assistant.message.delta", text: " Done.", timestamp: now() });
  await emit({ type: "assistant.message.completed", text: "I'll list files, then write a note. Done.", timestamp: now() });
  await emit({ type: "token.usage", inputTokens: 80, outputTokens: 24, timestamp: now() });
  await emit({
    type: "turn.completed",
    runId: input.turnId,
    sessionId: input.threadId,
    assistantMessage: "I'll list files, then write a note. Done.",
    timestamp: now(),
  });
  return engineResult("I'll list files, then write a note. Done.");
};

test("mock frontend consumes Codex-shaped thread, turn, and item session output", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, turnRunner: richRunner });
  const ui = await MockAppServerFrontend.connect(server.ready.url, { name: "mock-ui" });
  try {
    const initialized = await ui.initialize();
    const capabilities = record(initialized.result?.capabilities);
    const serverInfo = record(initialized.result?.serverInfo);
    assert.equal(initialized.result?.protocolVersion, 1);
    assert.equal(serverInfo.name, "reaper-app-server");
    assert.equal(capabilities.streaming, true);
    assert.equal(capabilities.itemStartedCompleted, true);
    assert.equal(capabilities.threadTurnsList, true);
    assert.equal(capabilities.disconnectDoesNotAbort, true);
    await ui.waitForMethod("initialized");

    const started = await ui.startThread({
      threadId: "frontend-session",
      title: "Mock UI session",
    });
    const startedThread = record(started.result?.thread);
    assert.equal(startedThread.id, "frontend-session");
    assert.equal(startedThread.sessionId, "app-frontend-session");
    assert.equal(startedThread.ephemeral, false);
    assert.equal(started.result?.approvalPolicy, "accept_edits");
    assert.equal(started.result?.cwd, workspaceRoot);
    assert.equal(startedThread.name, "Mock UI session");

    const turn = await ui.startTurn({
      threadId: "frontend-session",
      input: [{ type: "text", text: "Inspect the repo and leave a note" }],
    });
    const startedTurn = record(turn.result?.turn);
    assert.equal(turn.result?.accepted, true);
    assert.equal(startedTurn.status, "inProgress");
    const turnId = String(turn.result?.turnId);

    const turnStarted = await ui.waitForMethod("turn/started");
    assert.deepEqual(turnStarted.params?.turn, { id: turnId, status: "inProgress", items: [] });

    await ui.waitForTurnCompleted("frontend-session");
    await ui.waitForIdle("frontend-session");

    const required = [
      "initialized",
      "thread/started",
      "turn/queued",
      "thread/status/changed",
      "turn/started",
      "item/started",
      "item/completed",
      "item/reasoning/textDelta",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
      "item/verification/updated",
      "item/compaction/updated",
      "thread/tokenUsage/updated",
      "turn/completed",
    ];
    for (const method of required) {
      assert.ok(ui.methods.includes(method), `frontend never saw ${method}; got ${ui.methods.join(", ")}`);
    }

    const types = ui.itemTypes("frontend-session", turnId);
    assert.deepEqual(types, [
      "userMessage",
      "reasoning",
      "agentMessage",
      "commandExecution",
      "fileChange",
      "dynamicToolCall",
      "contextCompaction",
    ]);
    assert.deepEqual(ui.userTexts("frontend-session"), ["Inspect the repo and leave a note"]);
    assert.equal(ui.agentText("frontend-session", turnId), "I'll list files, then write a note. Done.");

    const named = await ui.setThreadName("frontend-session", "Frontend walkthrough");
    assert.equal(named.error, undefined);
    await ui.waitFor((message) => message.method === "thread/name/updated");
    assert.equal(ui.threads.get("frontend-session")?.name, "Frontend walkthrough");

    const listed = await ui.listThreads();
    const listedThread = record(asArray(listed.result?.data)[0]);
    assert.equal(listedThread.id, "frontend-session");
    const read = await ui.readThread("frontend-session", true);
    assert.equal(record(read.result?.thread).id, "frontend-session");
    const turns = await ui.listTurns("frontend-session");
    const persistedTurns = asArray(turns.result?.data);
    assert.equal(persistedTurns.length, 1);
    assert.equal(record(persistedTurns[0]).id, turnId);
    const serverTypes = asArray(record(persistedTurns[0]).items).map((item) => String(record(item).type));
    assert.deepEqual(serverTypes, types);
    const items = await ui.listItems("frontend-session");
    assert.equal(asArray(items.result?.data).length, types.length);

    const live = ui.snapshot("frontend-session")!.thread.turns[0]!;
    const persisted = record(persistedTurns[0]) as { items: Array<{ id: string; type: string }> };
    assert.deepEqual(
      live.items.map((item) => ({ id: item.id, type: item.type })),
      persisted.items.map((item) => ({ id: item.id, type: item.type })),
    );

    const command = live.items.find((item) => item.type === "commandExecution");
    assert.equal(command?.status, "completed");
    assert.equal(command?.aggregatedOutput, "README.md\n");
    const file = live.items.find((item) => item.type === "fileChange");
    assert.equal(file?.status, "completed");
    const tool = live.items.find((item) => item.type === "dynamicToolCall");
    assert.equal(tool?.tool, "web_search");
    assert.ok(ui.threads.get("frontend-session")?.tokenUsage);
  } finally {
    ui.close();
    await server.stop();
  }
});

test("mock frontend reconnects without aborting and keeps journal plus live turns", async () => {
  const workspaceRoot = await createTempWorkspace();
  let release!: () => void;
  let heldFirstTurn = false;
  const runner: ManagedTurnRunner = async (input) => {
    const assistantMessage = heldFirstTurn ? "second done" : "working later";
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: now(),
    });
    await input.eventSink({
      type: "assistant.message.delta",
      text: heldFirstTurn ? "second" : "working",
      timestamp: now(),
    });
    if (!heldFirstTurn) {
      heldFirstTurn = true;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(input.abortSignal.reason ?? new Error("aborted"));
        if (input.abortSignal.aborted) {
          onAbort();
          return;
        }
        input.abortSignal.addEventListener("abort", onAbort, { once: true });
        release = () => {
          input.abortSignal.removeEventListener("abort", onAbort);
          resolve();
        };
      });
    }
    await input.eventSink({
      type: "assistant.message.completed",
      text: assistantMessage,
      timestamp: now(),
    });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage,
      timestamp: now(),
    });
    return engineResult(assistantMessage);
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const first = await MockAppServerFrontend.connect(server.ready.url, { name: "ui-a" });
  let second: MockAppServerFrontend | undefined;
  try {
    await first.initialize();
    await first.startThread({ threadId: "durable-ui" });
    await first.startTurn({ threadId: "durable-ui", prompt: "first prompt" });
    await first.waitForMethod("turn/started");
    await first.waitForMethod("item/agentMessage/delta");
    first.close();

    second = await MockAppServerFrontend.connect(server.ready.url, { name: "ui-b" });
    await second.initialize();
    const resumed = await second.resumeThread({
      threadId: "durable-ui",
      subscribe: true,
      afterSequence: 0,
    }, 8_000);
    assert.equal(resumed.error, undefined);
    assert.equal(record(resumed.result?.thread).id, "durable-ui");
    assert.equal(typeof release, "function");
    const completed = second.waitFor((message) => message.method === "turn/completed", 8_000);
    release();
    await completed;
    await second.waitForIdle("durable-ui", 8_000);
    const completedItem = second.notifications.find((message) =>
      message.method === "item/completed" && record(message.params?.item).type === "agentMessage"
    );
    assert.equal(record(completedItem?.params?.item).text, "working later");
    assert.equal(second.agentText("durable-ui"), "working later");

    const thirdTurn = await second.startTurn({
      threadId: "durable-ui",
      input: [{ type: "text", text: "second prompt" }],
    });
    const secondTurnId = String(thirdTurn.result?.turnId);
    await second.waitFor(
      (message) => message.method === "turn/completed" && message.params?.turnId === secondTurnId,
      8_000,
    );
    const turns = await second.listTurns("durable-ui");
    const userTexts = asArray(turns.result?.data).flatMap((turn) => {
      const items = asArray(record(turn).items);
      return items
        .filter((item) => record(item).type === "userMessage")
        .flatMap((item) => asArray(record(item).content).map((part) => String(record(part).text ?? "")));
    });
    assert.deepEqual(userTexts, ["first prompt", "second prompt"]);
    assert.equal(thirdTurn.result?.accepted, true);
  } finally {
    first.close();
    second?.close();
    await server.stop();
  }
});

test("mock frontend answers approval requests and never auto-approves on disconnect", async () => {
  const workspaceRoot = await createTempWorkspace();
  const decisions: string[] = [];
  const runner: ManagedTurnRunner = async (input) => {
    const decision = await input.approvalRequester.requestApproval({
      approvalId: "frontend-approval",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "write-approval", name: "write_file", args: { path: "approved.txt", content: "ok" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "File mutation requires confirmation",
    }, input.abortSignal);
    decisions.push(decision);
    return engineResult(decision);
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const ui = await MockAppServerFrontend.connect(server.ready.url, {
    name: "approver",
    autoApprove: false,
  });
  try {
    await ui.initialize();
    await ui.startThread({ threadId: "approval-ui", permissionMode: "strict" });
    await ui.startTurn({ threadId: "approval-ui", prompt: "write a file" });
    const approval = await ui.waitFor((message) => message.method === "item/fileChange/requestApproval");
    assert.equal(approval.params?.approvalId, "frontend-approval");
    assert.ok(Array.isArray(approval.params?.availableDecisions));
    ui.approveNext("accept");
    await ui.waitForIdle("approval-ui");
    assert.deepEqual(decisions, ["approved"]);
  } finally {
    ui.close();
    await server.stop();
  }
});

test("mock frontend interrupt stops the live turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: now(),
    });
    await new Promise<void>((_resolve, reject) => {
      input.abortSignal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
    });
    return engineResult("");
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const ui = await MockAppServerFrontend.connect(server.ready.url, { name: "interrupt-ui" });
  try {
    await ui.initialize();
    await ui.startThread({ threadId: "interrupt-ui" });
    const started = await ui.startTurn({ threadId: "interrupt-ui", prompt: "wait" });
    await ui.waitForMethod("turn/started");
    const interrupted = await ui.interrupt({
      threadId: "interrupt-ui",
      turnId: started.result?.turnId,
    });
    assert.equal(interrupted.result?.interrupted, true);
    await ui.waitForIdle("interrupt-ui");
    const completed = ui.notifications.find((message) => message.method === "turn/completed");
    assert.equal(record(completed?.params?.turn).status, "interrupted");
  } finally {
    ui.close();
    await server.stop();
  }
});

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
