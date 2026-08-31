/**
 * End-to-end through the real stack: a browser-shaped WebSocket client speaks
 * to the BFF, which speaks to a real app-server.
 *
 * No browser and no model credentials — `turnRunner` is a fake, which is the
 * whole point of the app-server's embedding hook. What is real: the JSON-RPC
 * framing, the projection, the notification stream, the approval round trip,
 * and the BFF's id-space translation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

import type { ManagedTurnRunner } from "../../src/app-server/managed-turn-runner.js";
import { startAppServer, type RunningAppServer } from "../../src/app-server/server.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import { startBff, type RunningBff } from "../../web/bff/src/server.js";
import { applyNotification, emptyThreads, type ThreadsState } from "../../web/shared/src/index.js";

function engineResult(message: string): RuntimeEngineResult {
  return {
    assistantMessage: message,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

/** A browser-shaped client: raw frames in, raw frames out. */
class TabClient {
  private nextId = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  readonly notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  state: ThreadsState = emptyThreads();

  private constructor(private readonly socket: WebSocket) {}

  static async open(url: string): Promise<TabClient> {
    const socket = new WebSocket(url);
    const client = new TabClient(socket);
    // Attach before awaiting open: the BFF sends `bff/ready` the instant the
    // connection lands, and a listener added a tick later misses it.
    socket.on("message", (raw) => client.receive(String(raw)));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw);
    if (message.id !== undefined && this.pending.has(message.id)) {
      this.pending.get(message.id)!(message);
      this.pending.delete(message.id);
      return;
    }
    if (typeof message.method === "string") {
      this.notifications.push({ method: message.method, params: message.params ?? {} });
      this.state = applyNotification(this.state, message.method, message.params ?? {});
    }
  }

  call(method: string, params?: unknown): Promise<any> {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve) => this.pending.set(id, resolve));
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  async waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  close(): void {
    this.socket.close();
  }
}

interface Harness {
  appServer: RunningAppServer;
  bff: RunningBff;
  workspace: string;
  stop(): Promise<void>;
}

async function harness(turnRunner: ManagedTurnRunner): Promise<Harness> {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-web-"));
  const appServer = await startAppServer({
    workspaceRoot: workspace,
    listen: "ws://127.0.0.1:0",
    turnRunner,
    approvalTimeoutMs: 3_000,
  });
  const bff = await startBff({
    appServerUrl: appServer.ready.url,
    host: "127.0.0.1",
    port: 0,
    workspaceRoot: workspace,
  });
  return {
    appServer,
    bff,
    workspace,
    async stop() {
      await bff.close();
      await appServer.stop();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function wsUrl(bff: RunningBff): string {
  return `${bff.url.replace("http", "ws")}/ws`;
}

test("a browser client drives a turn through the BFF and sees the transcript", async () => {
  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
    await input.eventSink({ type: "assistant.message.delta", text: "Working", timestamp: timestamp() });
    await input.eventSink({ type: "assistant.message.delta", text: " on it.", timestamp: timestamp() });
    await input.eventSink({ type: "assistant.message.completed", text: "Working on it.", timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: "Working on it.",
      timestamp: timestamp(),
    });
    return engineResult("Working on it.");
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;
    assert.ok(threadId, "thread/start returned no thread id");

    await tab.call("turn/start", { threadId, prompt: "do a thing" });
    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "turn/completed"),
      "turn/completed",
    );

    // The browser folded the notification stream into the same shape the
    // server projects. This is the claim the whole UI rests on.
    const thread = tab.state[threadId];
    assert.ok(thread, "client never built the thread");
    const items = thread.turns.flatMap((turn) => turn.items);
    const agentMessage = items.find((item) => item.type === "agentMessage");
    assert.equal(
      agentMessage?.type === "agentMessage" ? agentMessage.text : undefined,
      "Working on it.",
      "streamed deltas did not accumulate in the client",
    );

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("an approval round-trips from the agent to the browser and back", async () => {
  let decision: string | undefined;
  const stack = await harness(async (input) => {
    decision = await input.approvalRequester.requestApproval({
      approvalId: "approval-web-1",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "bash-1", name: "bash", args: { cmd: "rm -rf build" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "destructive command",
    }, input.abortSignal);
    return engineResult(`decision=${decision}`);
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");

    const started = await tab.call("thread/start", { permissionMode: "strict", subscribe: true });
    const threadId = started.result.thread.id;
    void tab.call("turn/start", { threadId, prompt: "clean up" });

    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "approval/requested"),
      "approval/requested",
    );

    const request = tab.notifications.find((n) => n.method === "approval/requested")!;
    // The browser must never see the app-server's own request id — only the
    // stable approvalId the BFF keys its translation table on.
    assert.ok(request.params.approvalId, "approval carried no approvalId");
    assert.ok(
      Array.isArray(request.params.availableDecisions),
      "UI renders buttons from availableDecisions; the server must supply them",
    );

    tab.notify("approval/respond", {
      approvalId: request.params.approvalId,
      decision: "accept",
    });

    await tab.waitFor(() => decision !== undefined, "the agent to unblock");
    assert.equal(decision, "approved", "the agent did not receive the browser's decision");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("closing a tab cancels the approval it was blocking", async () => {
  // The app-server drops turn ownership when the owning *connection* closes.
  // The BFF is one connection for every tab, so that never fires here — this
  // asserts the BFF does the cancelling itself. Without it, a closed tab hangs
  // the agent for the full approval timeout.
  let decision: string | undefined;
  const stack = await harness(async (input) => {
    decision = await input.approvalRequester.requestApproval({
      approvalId: "approval-web-2",
      runId: input.turnId,
      sessionId: input.threadId,
      toolCall: { id: "bash-1", name: "bash", args: { cmd: "sleep 60" } },
      workspaceRoot: input.workspaceRoot,
      workingDirectory: input.workspaceRoot,
      permissionMode: "strict",
      reason: "long command",
    }, input.abortSignal);
    return engineResult("done");
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");

    const started = await tab.call("thread/start", { permissionMode: "strict", subscribe: true });
    const threadId = started.result.thread.id;
    void tab.call("turn/start", { threadId, prompt: "sleep" });

    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "approval/requested"),
      "approval/requested",
    );

    tab.close();

    // Must unblock well before the 3s approval timeout — otherwise the BFF is
    // not cancelling and the server's timer is doing the work.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && decision === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(decision, "cancelled", "a closed tab must release the agent immediately");
  } finally {
    await stack.stop();
  }
});

test("a message typed mid-turn queues and lands at the next model-loop boundary", async () => {
  // Gates the fake runner's two "model loop iterations" so the test can type a
  // message while the first one is still running — the exact situation a user
  // is in when they type during a tool call.
  let releaseFirstStep!: () => void;
  const firstStepRunning = new Promise<void>((resolve) => { releaseFirstStep = resolve; });
  let sawFirstStep!: () => void;
  const firstStepStarted = new Promise<void>((resolve) => { sawFirstStep = resolve; });
  let steeredIntoSecondStep: string[] = [];

  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });

    // Loop iteration 1: a long tool call. Nothing is drained mid-call, which is
    // what makes the queue meaningful rather than an interruption.
    sawFirstStep();
    await firstStepRunning;
    await input.eventSink({ type: "assistant.message.completed", text: "Step one done.", timestamp: timestamp() });

    // Loop boundary: the engine drains steering here (engine.ts:1298).
    steeredIntoSecondStep = input.turnControl.drain();

    await input.eventSink({ type: "assistant.message.completed", text: "Step two done.", timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: "done",
      timestamp: timestamp(),
    });
    return engineResult("done");
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    const turn = await tab.call("turn/start", { threadId, prompt: "first thing" });
    const turnId = turn.result.turnId;
    await firstStepStarted;

    // The user types while the agent is mid-step.
    const steer = await tab.call("turn/steer", { threadId, turnId, message: "also do the second thing" });
    assert.equal(steer.result.accepted, true, "a message typed mid-turn must be accepted, not refused");

    // Acceptance is not delivery: while the first step is still blocked, the
    // message must NOT appear in the transcript yet — otherwise the UI would
    // claim the agent has it when it is only queued.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const beforeRelease = tab.state[threadId]?.turns.some((t) =>
      t.items.some((item) => item.type === "userMessage" && item.content[0]?.text === "also do the second thing")) ?? false;
    assert.equal(beforeRelease, false, "the steered message must not appear in the transcript before it is drained");

    releaseFirstStep();

    // Once the engine drains at the loop boundary, the message lands in the
    // transcript — the delivery moment the UI waits for.
    await tab.waitFor(
      () => tab.state[threadId]?.turns.some((t) =>
        t.items.some((item) => item.type === "userMessage" && item.content[0]?.text === "also do the second thing")) ?? false,
      "the steered message to appear in the transcript once the engine drains",
    );
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "turn/completed"), "turn/completed");

    assert.deepEqual(
      steeredIntoSecondStep,
      ["also do the second thing"],
      "the queued message must reach the model at the next loop boundary",
    );

    // Both user messages survive: the queued one appended, it did not replace
    // the original prompt.
    const userMessages = tab.state[threadId]!.turns
      .flatMap((t) => t.items)
      .filter((item) => item.type === "userMessage")
      .map((item) => (item.type === "userMessage" ? item.content[0]?.text : undefined));
    assert.deepEqual(userMessages, ["first thing", "also do the second thing"]);

    tab.close();
  } finally {
    releaseFirstStep();
    await stack.stop();
  }
});

test("steering a turn that already ended is refused, not silently dropped", async () => {
  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: "done",
      timestamp: timestamp(),
    });
    return engineResult("done");
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");
    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    const turn = await tab.call("turn/start", { threadId, prompt: "quick thing" });
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "turn/completed"), "turn/completed");

    // The UI relies on this being an explicit `accepted: false` with a reason:
    // that is what tells it to fall back to starting a new turn instead of
    // dropping the user's message on the floor.
    const steer = await tab.call("turn/steer", { threadId, turnId: turn.result.turnId, message: "too late" });
    assert.equal(steer.result.accepted, false);
    assert.equal(steer.result.reason, "closed");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("the BFF refuses methods outside its allowlist", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.bff));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "bff/ready"), "bff/ready");

    // `initialize` is real app-server protocol, but the BFF owns that
    // handshake. A tab must not be able to reach it.
    const response = await tab.call("initialize", { protocolVersion: 1 });
    assert.ok(response.error, "initialize must not be proxied from a browser tab");
    assert.equal(response.error.code, -32601);

    tab.close();
  } finally {
    await stack.stop();
  }
});
