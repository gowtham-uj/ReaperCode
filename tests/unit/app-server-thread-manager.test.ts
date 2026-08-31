import test from "node:test";
import assert from "node:assert/strict";

import { ReaperThreadManager } from "../../src/app-server/thread-manager.js";
import type { ManagedTurnRunner, ManagedTurnRunnerInput } from "../../src/app-server/managed-turn-runner.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

function result(assistantMessage = "done"): RuntimeEngineResult {
  return {
    assistantMessage,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

function immediateRunner(inputs: ManagedTurnRunnerInput[] = []): ManagedTurnRunner {
  return async (input) => {
    inputs.push(input);
    await input.eventSink({
      type: "assistant.message.delta",
      text: "done",
      timestamp: new Date().toISOString(),
    });
    return result();
  };
}

test("managed threads persist identity and reuse the named session after restart", async () => {
  const workspaceRoot = await createTempWorkspace();
  const firstInputs: ManagedTurnRunnerInput[] = [];
  const first = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    turnRunner: immediateRunner(firstInputs),
  });
  const thread = await first.startThread({
    threadId: "persistent-thread",
    workspaceRoot,
  });
  const firstTurn = await thread.startTurn({ prompt: "first" });
  await firstTurn.completion;

  const secondInputs: ManagedTurnRunnerInput[] = [];
  const second = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    turnRunner: immediateRunner(secondInputs),
  });
  const resumed = await second.resumeThread("persistent-thread");
  const secondTurn = await resumed.startTurn({ prompt: "second" });
  await secondTurn.completion;

  assert.equal(firstInputs[0]?.sessionName, "app-persistent-thread");
  assert.equal(secondInputs[0]?.sessionName, "app-persistent-thread");
  assert.equal(secondInputs[0]?.threadId, "persistent-thread");
  assert.equal(resumed.metadata.permissionMode, "accept_edits");
  assert.equal((await second.listThreads()).length, 1);
});

test("one thread rejects overlapping turns while different threads share the concurrency limit", async () => {
  const workspaceRoot = await createTempWorkspace();
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const runner: ManagedTurnRunner = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return result();
  };
  const manager = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    maxConcurrentTurns: 1,
    turnRunner: runner,
  });
  const a = await manager.startThread({ threadId: "thread-a", workspaceRoot });
  const b = await manager.startThread({ threadId: "thread-b", workspaceRoot });
  const turnA = await a.startTurn({ prompt: "a" });
  await assert.rejects(a.startTurn({ prompt: "overlap" }), /active turn/);
  const turnB = await b.startTurn({ prompt: "b" });

  await waitFor(() => releases.length === 1);
  releases.shift()?.();
  await waitFor(() => releases.length === 1);
  releases.shift()?.();
  await Promise.all([turnA.completion, turnB.completion]);
  assert.equal(maximum, 1);
});

test("two threads can run concurrently without sharing turn identity", async () => {
  const workspaceRoot = await createTempWorkspace();
  let active = 0;
  let maximum = 0;
  const seen: string[] = [];
  const releases: Array<() => void> = [];
  const runner: ManagedTurnRunner = async (input) => {
    seen.push(`${input.threadId}:${input.sessionName}`);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return result(input.threadId);
  };
  const manager = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    maxConcurrentTurns: 2,
    turnRunner: runner,
  });
  const a = await manager.startThread({ threadId: "iso-a", workspaceRoot });
  const b = await manager.startThread({ threadId: "iso-b", workspaceRoot });
  const turnA = await a.startTurn({ prompt: "a" });
  const turnB = await b.startTurn({ prompt: "b" });
  await waitFor(() => releases.length === 2);
  assert.equal(maximum, 2);
  for (const release of releases.splice(0)) release();
  const [summaryA, summaryB] = await Promise.all([turnA.completion, turnB.completion]);
  assert.equal(summaryA.assistantMessage, "iso-a");
  assert.equal(summaryB.assistantMessage, "iso-b");
  assert.deepEqual(seen.sort(), ["iso-a:app-iso-a", "iso-b:app-iso-b"]);
});

test("thread event replay is bounded and subscriptions do not control turn lifetime", async () => {
  const workspaceRoot = await createTempWorkspace();
  const manager = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    maxReplayEvents: 3,
    turnRunner: immediateRunner(),
  });
  const thread = await manager.startThread({ threadId: "events", workspaceRoot });
  const delivered: number[] = [];
  const subscription = await manager.subscribe(
    thread.threadId,
    "client-1",
    (event) => { delivered.push(event.sequence); },
  );
  const handle = await thread.startTurn({ prompt: "stream" });
  subscription.unsubscribe();
  const summary = await handle.completion;

  assert.equal(summary.status, "completed");
  assert.ok(delivered.length > 0);
  const replay = thread.replayAfter(1);
  assert.equal(replay.events.length, 3);
  assert.equal(replay.truncated, true);
});

test("interrupt aborts a managed turn without closing its thread", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(input.abortSignal.reason ?? new Error("aborted"));
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
    });
    return result();
  };
  const manager = new ReaperThreadManager({ dataRoot: workspaceRoot, turnRunner: runner });
  const thread = await manager.startThread({ threadId: "interruptible", workspaceRoot });
  const handle = await thread.startTurn({ prompt: "wait" });
  assert.equal(thread.interrupt(handle.turnId), true);
  const summary = await handle.completion;

  assert.equal(summary.status, "aborted");
  assert.equal(thread.metadata.status, "idle");
  assert.equal(thread.interrupt(handle.turnId), false);
});

test("approvals remain pending until explicitly resolved and time out closed", async () => {
  const workspaceRoot = await createTempWorkspace();
  let approvalId = "";
  const runner: ManagedTurnRunner = async (input) => {
    const decision = await input.approvalRequester.requestApproval({
      approvalId: "approval-1",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "tool-1", name: "write_file", args: { path: "a.txt", content: "a" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "test",
    }, input.abortSignal);
    return result(decision);
  };
  const manager = new ReaperThreadManager({
    dataRoot: workspaceRoot,
    approvalTimeoutMs: 50,
    turnRunner: runner,
    onApprovalRequested: (request) => {
      approvalId = request.approvalId;
    },
  });
  const thread = await manager.startThread({
    threadId: "approval",
    workspaceRoot,
    permissionMode: "strict",
  });
  const handle = await thread.startTurn({ prompt: "write" });
  await waitFor(() => approvalId.length > 0);
  assert.equal(thread.pendingApprovalIds.includes(approvalId), true);
  assert.equal(await manager.resolveApproval(thread.threadId, approvalId, "approved"), true);
  assert.equal((await handle.completion).assistantMessage, "approved");

  const timeoutManager = new ReaperThreadManager({
    dataRoot: await createTempWorkspace(),
    approvalTimeoutMs: 5,
    turnRunner: runner,
  });
  const timeoutThread = await timeoutManager.startThread({
    threadId: "approval-timeout",
    workspaceRoot,
    permissionMode: "strict",
  });
  const timeoutHandle = await timeoutThread.startTurn({ prompt: "wait" });
  assert.equal((await timeoutHandle.completion).assistantMessage, "timeout");
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
