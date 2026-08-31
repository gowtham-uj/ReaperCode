import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { startAppServer } from "../../src/app-server/server.js";
import type { ManagedTurnRunner } from "../../src/app-server/managed-turn-runner.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import { appendEntry, initJournal, lastEntryId } from "../../src/context/session-journal.js";
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

const streamingRunner: ManagedTurnRunner = async (input) => {
  const timestamp = () => new Date().toISOString();
  await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
  await input.eventSink({ type: "assistant.reasoning.delta", text: "checking", timestamp: timestamp() });
  await input.eventSink({ type: "assistant.message.delta", text: "hello", timestamp: timestamp() });
  await input.eventSink({ type: "assistant.message.completed", text: "hello", timestamp: timestamp() });
  await input.eventSink({
    type: "turn.completed",
    runId: input.turnId,
    sessionId: input.threadId,
    assistantMessage: "hello",
    timestamp: timestamp(),
  });
  return engineResult("hello");
};

test("WebSocket app server requires initialize and streams separate JSON-RPC notifications", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, turnRunner: streamingRunner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    const rejected = await client.request("thread/list", {});
    assert.equal(rejected.error?.code, -32002);

    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "test" },
    });
    assert.equal(initialized.result?.protocolVersion, 1);
    assert.equal(initialized.result?.capabilities?.streaming, true);

    const started = await client.request("thread/start", { threadId: "ws-thread" });
    assert.equal(started.result?.approvalPolicy, "accept_edits");
    const accepted = await client.request("turn/start", {
      threadId: "ws-thread",
      prompt: "say hello",
    });
    assert.equal(accepted.result?.accepted, true);

    const delta = await client.waitFor((message) => message.method === "item/agentMessage/delta");
    const completed = await client.waitFor((message) => message.method === "turn/completed");
    assert.equal(delta.params?.delta, "hello");
    assert.ok(delta.params.sequence < completed.params.sequence);
  } finally {
    client.close();
    await server.stop();
  }
});

test("disconnect removes subscriptions but does not abort a running turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  let release!: () => void;
  const runner: ManagedTurnRunner = async (input) => {
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => { release = resolve; });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: "survived",
      timestamp: new Date().toISOString(),
    });
    return engineResult("survived");
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const first = await RpcClient.connect(server.ready.url);
  await first.request("initialize", { protocolVersion: 1 });
  await first.request("thread/start", { threadId: "durable-live" });
  await first.request("turn/start", { threadId: "durable-live", prompt: "wait" });
  await first.waitFor((message) => message.method === "turn/started");
  first.close();

  const second = await RpcClient.connect(server.ready.url);
  try {
    await second.request("initialize", { protocolVersion: 1 });
    await second.request("thread/resume", {
      threadId: "durable-live",
      subscribe: true,
      afterSequence: 0,
    });
    release();
    const completed = await second.waitFor((message) => message.method === "turn/completed");
    assert.equal(completed.params.turn.status, "completed");
  } finally {
    second.close();
    await server.stop();
  }
});

test("multiple subscribers receive the same live thread events", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, turnRunner: streamingRunner });
  const first = await RpcClient.connect(server.ready.url);
  const second = await RpcClient.connect(server.ready.url);
  try {
    await first.request("initialize", { protocolVersion: 1 });
    await second.request("initialize", { protocolVersion: 1 });
    await first.request("thread/start", { threadId: "shared-thread" });
    await second.request("thread/resume", { threadId: "shared-thread", subscribe: true });
    await first.request("turn/start", { threadId: "shared-thread", prompt: "stream" });
    const [left, right] = await Promise.all([
      first.waitFor((message) => message.method === "item/agentMessage/delta"),
      second.waitFor((message) => message.method === "item/agentMessage/delta"),
    ]);
    assert.equal(left.params.sequence, right.params.sequence);
    assert.equal(left.params.delta, "hello");
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("turn interrupt confirms the active runtime stopped", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: new Date().toISOString(),
    });
    await new Promise<void>((_resolve, reject) => {
      input.abortSignal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
    });
    return engineResult("");
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("thread/start", { threadId: "interrupt-ws" });
    const started = await client.request("turn/start", { threadId: "interrupt-ws", prompt: "wait" });
    await client.waitFor((message) => message.method === "turn/started");
    const interrupted = await client.request("turn/interrupt", {
      threadId: "interrupt-ws",
      turnId: started.result.turnId,
    });
    assert.equal(interrupted.result.interrupted, true);
    const idle = await client.waitFor(
      (message) => message.method === "thread/status/changed" && message.params.status === "idle",
    );
    assert.equal(idle.params.status, "idle");
  } finally {
    client.close();
    await server.stop();
  }
});

test("tool approval uses a server-initiated JSON-RPC request and resumes the turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    const decision = await input.approvalRequester.requestApproval({
      approvalId: "approval-over-ws",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "tool-write", name: "write_file", args: { path: "approved.txt", content: "ok" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "File mutation requires confirmation",
    }, input.abortSignal);
    return engineResult(decision);
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("thread/start", {
      threadId: "approval-ws",
      permissionMode: "strict",
    });
    await client.request("turn/start", {
      threadId: "approval-ws",
      prompt: "write",
    });
    const approval = await client.waitFor(
      (message) => message.method === "item/fileChange/requestApproval",
    );
    assert.equal(approval.params.approvalId, "approval-over-ws");
    client.respond(approval.id!, { decision: "approved" });
    const status = await client.waitFor(
      (message) => message.method === "thread/status/changed" && message.params.status === "idle",
    );
    assert.equal(status.params.status, "idle");
  } finally {
    client.close();
    await server.stop();
  }
});

test("approval timeout notifies the reviewer instead of leaving a stale prompt", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    const decision = await input.approvalRequester.requestApproval({
      approvalId: "timeout-approval",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "shell", name: "bash", args: { cmd: "printf slow" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "test timeout",
    }, input.abortSignal);
    return engineResult(decision);
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner, approvalTimeoutMs: 50 });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1 });
    await client.request("thread/start", { threadId: "timeout-approval-thread", permissionMode: "strict" });
    await client.request("turn/start", { threadId: "timeout-approval-thread", prompt: "run" });
    const approval = await client.waitFor(
      (message) => message.method === "item/commandExecution/requestApproval",
    );

    // Deliberately never respond. Before the fix the reviewer got nothing here
    // and could not tell "still waiting" from "expired".
    const resolved = await client.waitFor((message) => message.method === "serverRequest/resolved");
    assert.equal(resolved.params.requestId, approval.id);
    assert.equal(resolved.params.decision, "timeout");
  } finally {
    client.close();
    await server.stop();
  }
});

test("reviewer disconnect cancels a pending approval without aborting the server", async () => {
  const workspaceRoot = await createTempWorkspace();
  const runner: ManagedTurnRunner = async (input) => {
    const decision = await input.approvalRequester.requestApproval({
      approvalId: "disconnect-approval",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "shell", name: "bash", args: { cmd: "printf no" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "test disconnect",
    }, input.abortSignal);
    return engineResult(decision);
  };
  const server = await startAppServer({ workspaceRoot, turnRunner: runner });
  const reviewer = await RpcClient.connect(server.ready.url);
  await reviewer.request("initialize", { protocolVersion: 1 });
  await reviewer.request("thread/start", { threadId: "disconnect-reviewer", permissionMode: "strict" });
  await reviewer.request("turn/start", { threadId: "disconnect-reviewer", prompt: "run" });
  await reviewer.waitFor((message) => message.method === "item/commandExecution/requestApproval");
  reviewer.close();

  const observer = await RpcClient.connect(server.ready.url);
  try {
    await observer.request("initialize", { protocolVersion: 1 });
    await observer.request("thread/resume", { threadId: "disconnect-reviewer", subscribe: true });
    const idle = await observer.waitFor(
      (message) => message.method === "thread/status/changed" && message.params.status === "idle",
    );
    assert.equal(idle.params.status, "idle");
  } finally {
    observer.close();
    await server.stop();
  }
});

test("oversized messages receive a structured error before disconnect", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({
    workspaceRoot,
    maxMessageBytes: 256,
    turnRunner: streamingRunner,
  });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1 });
    client.sendRaw({
      jsonrpc: "2.0",
      id: 999,
      method: "thread/start",
      params: { title: "x".repeat(1_000) },
    });
    const error = await client.waitFor((message) => message.id === "oversized-message");
    assert.equal(error.error?.code, -32600);
  } finally {
    client.close();
    await server.stop();
  }
});

test("Codex-shaped thread, turn, and item objects stream and persist", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({ workspaceRoot, turnRunner: streamingRunner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "codex-like" },
    });
    assert.equal(initialized.result.capabilities.itemStartedCompleted, true);
    const handshake = await client.waitFor((message) => message.method === "initialized");
    assert.equal(handshake.method, "initialized");

    const started = await client.request("thread/start", {
      threadId: "codex-thread",
      title: "Codex parity",
    });
    assert.equal(started.result.thread.id, "codex-thread");
    assert.equal(started.result.thread.sessionId, "app-codex-thread");
    assert.equal(started.result.approvalPolicy, "accept_edits");
    assert.equal(started.result.cwd, workspaceRoot);

    await client.request("turn/start", {
      threadId: "codex-thread",
      input: [{ type: "text", text: "say hello" }],
    });
    const turnStarted = await client.waitFor((message) => message.method === "turn/started");
    assert.deepEqual(turnStarted.params.turn.items, []);
    const delta = await client.waitFor((message) => message.method === "item/agentMessage/delta");
    assert.equal(delta.params.delta, "hello");
    const itemCompleted = await client.waitFor(
      (message) => message.method === "item/completed" && message.params.item?.type === "agentMessage",
    );
    assert.equal(itemCompleted.params.item.text, "hello");
    const turnCompleted = await client.waitFor((message) => message.method === "turn/completed");
    assert.equal(turnCompleted.params.turn.status, "completed");
    assert.ok(turnCompleted.params.turn.items.some((item: { type: string }) => item.type === "agentMessage"));

    const listed = await client.request("thread/list", {});
    assert.equal(listed.result.data[0].id, "codex-thread");
    const read = await client.request("thread/read", { threadId: "codex-thread", includeTurns: true });
    assert.equal(read.result.thread.id, "codex-thread");
    const turns = await client.request("thread/turns/list", { threadId: "codex-thread", itemsView: "full" });
    assert.ok(Array.isArray(turns.result.data));
    assert.ok(turns.result.data.some((turn: { items: Array<{ type: string }> }) =>
      turn.items.some((item) => item.type === "userMessage" || item.type === "agentMessage")));
  } finally {
    client.close();
    await server.stop();
  }
});

test("thread/turns/list keeps journal history after a live turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const threadId = "history-live";
  const sessionName = `app-${threadId}`;
  await initJournal({ name: sessionName, workspaceRoot, cwd: workspaceRoot });
  await appendEntry(workspaceRoot, sessionName, {
    id: "hist-user",
    parentId: lastEntryId(workspaceRoot, sessionName),
    type: "message",
    ts: new Date().toISOString(),
    payload: { role: "user", content: "prior work", ts: Date.now() },
  });
  await appendEntry(workspaceRoot, sessionName, {
    id: "hist-asst",
    parentId: lastEntryId(workspaceRoot, sessionName),
    type: "message",
    ts: new Date().toISOString(),
    payload: { role: "assistant", content: "already done", ts: Date.now() },
  });
  const server = await startAppServer({ workspaceRoot, turnRunner: streamingRunner });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "history" } });
    await client.request("thread/start", { threadId, title: "History live" });
    const before = await client.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc" });
    assert.equal(before.result.data.length, 1);
    await client.request("turn/start", { threadId, prompt: "say hello" });
    await client.waitFor((message) => message.method === "turn/completed");
    const after = await client.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "asc" });
    assert.equal(after.result.data.length, 2);
    const userTexts = after.result.data.flatMap((turn: { items: Array<{ type: string; content?: Array<{ text: string }> }> }) =>
      turn.items.filter((item) => item.type === "userMessage").flatMap((item) => item.content?.map((part) => part.text) ?? []));
    assert.deepEqual(userTexts, ["prior work", "say hello"]);
  } finally {
    client.close();
    await server.stop();
  }
});

test("inbound overload returns a retryable JSON-RPC error", async () => {
  const workspaceRoot = await createTempWorkspace();
  const server = await startAppServer({
    workspaceRoot,
    maxInboundMessages: 2,
    turnRunner: streamingRunner,
  });
  const client = await RpcClient.connect(server.ready.url);
  try {
    await client.request("initialize", { protocolVersion: 1, clientInfo: { name: "flood" } });
    for (let index = 0; index < 40; index += 1) {
      client.sendRaw({ jsonrpc: "2.0", id: `flood-${index}`, method: "thread/list", params: {} });
    }
    const overloaded = await client.waitFor((message) => message.error?.code === -32001, 3_000);
    assert.equal(overloaded.error?.code, -32001);
    assert.equal(overloaded.error?.data?.retryable, true);
  } finally {
    client.close();
    await server.stop();
  }
});

test("slow clients are evicted without aborting the running turn", async () => {
  const workspaceRoot = await createTempWorkspace();
  let hold!: () => void;
  let release!: () => void;
  const runner: ManagedTurnRunner = async (input) => {
    const waitUntil = (assign: (resolve: () => void) => void) => new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(input.abortSignal.reason ?? new Error("aborted"));
      if (input.abortSignal.aborted) {
        onAbort();
        return;
      }
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
      assign(() => {
        input.abortSignal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: new Date().toISOString(),
    });
    await waitUntil((resolve) => { hold = resolve; });
    for (let index = 0; index < 80; index += 1) {
      input.eventSink({
        type: "assistant.message.delta",
        text: `chunk-${index}-${"x".repeat(256)}`,
        timestamp: new Date().toISOString(),
      });
    }
    await waitUntil((resolve) => { release = resolve; });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: "survived-slow-client",
      timestamp: new Date().toISOString(),
    });
    return engineResult("survived-slow-client");
  };
  const server = await startAppServer({
    workspaceRoot,
    maxOutboundMessages: 24,
    outboundFlushDelayMs: 25,
    turnRunner: runner,
  });
  const first = await RpcClient.connect(server.ready.url);
  let second: RpcClient | undefined;
  try {
    await first.request("initialize", { protocolVersion: 1 });
    await first.request("thread/start", { threadId: "slow-client" });
    await first.request("turn/start", { threadId: "slow-client", prompt: "stream a lot" });
    await first.waitFor((message) => message.method === "turn/started");
    const closed = first.waitForClose(3_000);
    hold();
    assert.equal(await closed, 1013);
    assert.equal(server.manager.peekThread("slow-client")?.metadata.status, "running");

    const latest = server.manager.peekThread("slow-client")?.replayAfter(0).latestSequence ?? 0;
    second = await RpcClient.connect(server.ready.url);
    await second.request("initialize", { protocolVersion: 1 });
    await second.request("thread/resume", {
      threadId: "slow-client",
      subscribe: true,
      afterSequence: latest,
    });
    release();
    const completed = await second.waitFor((message) => message.method === "turn/completed");
    assert.equal(completed.params.turn.status, "completed");
    await waitFor(() => server.manager.peekThread("slow-client")?.metadata.status === "idle");
  } finally {
    release?.();
    first.close();
    second?.close();
    await server.stop();
  }
});

test("two concurrent thread turns stay isolated over WebSocket", async () => {
  const workspaceRoot = await createTempWorkspace();
  let active = 0;
  let maximum = 0;
  const releases: Array<() => void> = [];
  const runner: ManagedTurnRunner = async (input) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await input.eventSink({
      type: "turn.started",
      runId: input.turnId,
      sessionId: input.threadId,
      timestamp: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: input.threadId,
      timestamp: new Date().toISOString(),
    });
    return engineResult(input.threadId);
  };
  const server = await startAppServer({
    workspaceRoot,
    maxConcurrentTurns: 2,
    turnRunner: runner,
  });
  const first = await RpcClient.connect(server.ready.url);
  const second = await RpcClient.connect(server.ready.url);
  try {
    await first.request("initialize", { protocolVersion: 1 });
    await second.request("initialize", { protocolVersion: 1 });
    await first.request("thread/start", { threadId: "iso-one" });
    await second.request("thread/start", { threadId: "iso-two" });
    await Promise.all([
      first.request("turn/start", { threadId: "iso-one", prompt: "one" }),
      second.request("turn/start", { threadId: "iso-two", prompt: "two" }),
    ]);
    await waitFor(() => releases.length === 2);
    assert.equal(maximum, 2);
    for (const release of releases.splice(0)) release();
    const [left, right] = await Promise.all([
      first.waitFor((message) => message.method === "turn/completed"),
      second.waitFor((message) => message.method === "turn/completed"),
    ]);
    assert.equal(left.params.threadId, "iso-one");
    assert.equal(right.params.threadId, "iso-two");
  } finally {
    first.close();
    second.close();
    await server.stop();
  }
});

test("invalid bearer tokens are rejected during upgrade", async () => {
  const workspaceRoot = await createTempWorkspace();
  const token = "0123456789abcdef0123456789abcdef";
  const server = await startAppServer({
    workspaceRoot,
    authToken: token,
    turnRunner: streamingRunner,
  });
  try {
    await assert.rejects(
      RpcClient.connect(server.ready.url, { headers: { authorization: "Bearer totally-wrong-token" } }),
      /401|Unexpected server response/,
    );
    const authenticated = await RpcClient.connect(server.ready.url, {
      headers: { authorization: `Bearer ${token}` },
    });
    authenticated.close();
  } finally {
    await server.stop();
  }
});

test("bundled app-server starts from a clean directory and initializes", async (t) => {
  const bundleSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/reaper.mjs");
  if (!existsSync(bundleSrc)) {
    t.skip("bin/reaper.mjs is not present; run npm run build:binary first");
    return;
  }
  const workspaceRoot = await createTempWorkspace();
  const launchDir = path.join(workspaceRoot, "clean-launch");
  await mkdir(launchDir, { recursive: true });
  const bundleDest = path.join(launchDir, "reaper.mjs");
  await copyFile(bundleSrc, bundleDest);
  const child = spawn(process.execPath, [bundleDest, "app-server", "--listen", "ws://127.0.0.1:0", "--workspace", workspaceRoot], {
    cwd: launchDir,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let ready: { url: string } | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bundled app-server did not print a ready record")), 15_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.split("\n").map((line) => line.trim()).find((line) => line.includes("reaper.app-server.ready"));
      if (!match || ready) return;
      try {
        ready = JSON.parse(match) as { url: string };
        clearTimeout(timer);
        resolve();
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`bundled app-server exited ${code}`));
      }
    });
  });
  try {
    await readyPromise;
    assert.ok(ready?.url.startsWith("ws://"));
    const client = await RpcClient.connect(ready!.url);
    try {
      const initialized = await client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "bundle-smoke" },
      });
      assert.equal(initialized.result?.protocolVersion, 1);
      assert.equal(initialized.result?.capabilities?.streaming, true);
    } finally {
      client.close();
    }
  } finally {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000)),
    ]);
  }
});

test("non-loopback security rules require auth and reject browser origins", async () => {
  const workspaceRoot = await createTempWorkspace();
  await assert.rejects(
    startAppServer({ workspaceRoot, listen: "ws://0.0.0.0:0", turnRunner: streamingRunner }),
    /require.*auth-token/i,
  );

  const server = await startAppServer({
    workspaceRoot,
    authToken: "0123456789abcdef0123456789abcdef",
    turnRunner: streamingRunner,
  });
  try {
    await assert.rejects(RpcClient.connect(server.ready.url), /401|Unexpected server response/);
    await assert.rejects(
      RpcClient.connect(server.ready.url, {
        headers: {
          authorization: "Bearer 0123456789abcdef0123456789abcdef",
          origin: "https://example.com",
        },
      }),
      /403|Unexpected server response/,
    );
    const authenticated = await RpcClient.connect(server.ready.url, {
      headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
    });
    authenticated.close();
  } finally {
    await server.stop();
  }
});

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  result?: any;
  error?: { code: number; message: string; data?: { retryable?: boolean } };
  params?: any;
}

class RpcClient {
  private nextId = 1;
  private readonly messages: RpcMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private closeCode: number | undefined;
  private readonly closeWaiters: Array<(code: number) => void> = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as RpcMessage;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
    socket.on("close", (code) => {
      this.closeCode = code;
      for (const waiter of this.closeWaiters.splice(0)) waiter(code);
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`WebSocket closed ${code}`));
      }
    });
  }

  static async connect(url: string, options: { headers?: Record<string, string> } = {}): Promise<RpcClient> {
    const socket = new WebSocket(url, options);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`Unexpected server response: ${response.statusCode}`));
      });
    });
    return new RpcClient(socket);
  }

  async request(method: string, params: unknown): Promise<RpcMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await this.waitFor((message) => message.id === id);
  }

  respond(id: string | number, result: unknown): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  sendRaw(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  async waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 2_000): Promise<RpcMessage> {
    const existing = this.messages.findIndex(predicate);
    if (existing >= 0) return this.messages.splice(existing, 1)[0]!;
    return await new Promise<RpcMessage>((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: (() => {
          const timer = setTimeout(() => {
            const index = this.waiters.indexOf(waiter);
            if (index >= 0) this.waiters.splice(index, 1);
            reject(new Error("Timed out waiting for WebSocket message"));
          }, timeoutMs);
          timer.unref();
          return timer;
        })(),
      };
      this.waiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 2_000): Promise<number> {
    if (this.closeCode !== undefined) return Promise.resolve(this.closeCode);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for WebSocket close")), timeoutMs);
      timer.unref();
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  close(): void {
    this.socket.close();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WebSocket client closed"));
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
