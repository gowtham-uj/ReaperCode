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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import { WebSocket } from "ws";

import { ProviderCredentialStore } from "../../src/config/provider-credentials.js";
import { ProviderIntegrationRegistry } from "../../src/model/provider/integration-registry.js";
import type { ProviderIntegration } from "../../src/model/provider/types.js";
import { PersistentMemoryStore } from "../../src/adaptive/persistent-memory-store.js";
import type { ManagedTurnRunner } from "../../src/app-server/managed-turn-runner.js";
import { startAppServer, type RunningAppServer } from "../../src/app-server/server.js";
import type { RunningBrowserGateway } from "../../src/app-server/web/gateway.js";
import type { RuntimeEngineResult } from "../../src/runtime/engine.js";
import {
  applyNotification,
  emptyThreads,
  hydrateFromTurns,
  type ThreadsState,
} from "../../web/shared/src/index.js";

function engineResult(message: string): RuntimeEngineResult {
  return {
    assistantMessage: message,
    toolResults: [],
    events: [],
    trajectoryPath: "",
    state: {} as RuntimeEngineResult["state"],
  };
}

const testProviderIntegration: ProviderIntegration = {
  descriptor: {
    id: "fixture-openai",
    label: "Fixture OpenAI",
    sdkFamily: "openai-chat",
    baseUrl: "https://example.invalid/v1",
    envVar: "FIXTURE_OPENAI_API_KEY",
    keyHint: "test only",
    defaultModel: "fixture-model",
    models: ["fixture-model"],
    modelDetails: {
      "fixture-model": {
        id: "fixture-model",
        name: "Fixture Model",
        contextTokens: 16_000,
        supportsToolCalls: true,
      },
    },
    capabilities: {
      streaming: true,
      toolCalling: true,
      jsonMode: true,
      structuredOutput: true,
      embeddings: false,
      maxContextTokens: 16_000,
      maxOutputTokens: 4_000,
    },
    authScheme: "bearer",
  },
  authMethods: [
    { id: "api-key", type: "api", label: "API key" },
    {
      id: "oauth-code",
      type: "oauth",
      label: "Sign in with Fixture",
      authorize: async () => ({
        url: "https://auth.example.invalid/authorize",
        mode: "code",
        instructions: "Authorize in the browser, then paste the code.",
        complete: async (code?: string) => code === "fixture-code"
          ? {
              type: "success" as const,
              auth: {
                type: "oauth" as const,
                access: "fixture-access-token-never-return",
                refresh: "fixture-refresh-token-never-return",
                expires: Date.now() + 60_000,
                accountId: "fixture@example.test",
              },
            }
          : { type: "failed" as const, message: "Invalid authorization code" },
      }),
    },
  ],
};

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
    // Attach before awaiting open: the gateway sends `browser/ready` the instant the
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
  gateway: RunningBrowserGateway;
  workspace: string;
  stop(): Promise<void>;
}

async function harness(
  turnRunner: ManagedTurnRunner,
  options: { maxReplayEvents?: number; credentialHome?: string; memoryStore?: PersistentMemoryStore; providerIntegrations?: ProviderIntegration[] } = {},
): Promise<Harness> {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-web-"));
  const credentials = new ProviderCredentialStore({ home: options.credentialHome ?? workspace });
  const appServer = await startAppServer({
    workspaceRoot: workspace,
    listen: "ws://127.0.0.1:0",
    turnRunner,
    approvalTimeoutMs: 3_000,
    // Always a temp home, never the developer's real `~/.reaper`: a test that
    // reads real credentials would pass locally and fail in CI, and a test that
    // *wrote* them would destroy the developer's keys.
    credentials,
    settingsHome: workspace,
    ...(options.providerIntegrations
      ? { providers: new ProviderIntegrationRegistry(options.providerIntegrations, credentials) }
      : {}),
    ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
    ...(options.maxReplayEvents !== undefined ? { maxReplayEvents: options.maxReplayEvents } : {}),
    // The browser gateway is mounted in-process — the merged architecture. It
    // is a second listener of the same server, not a separate process.
    web: { host: "127.0.0.1", port: 0 },
  });
  const gateway = appServer.web!;
  return {
    appServer,
    gateway,
    workspace,
    async stop() {
      await appServer.stop();
      await rm(workspace, { recursive: true, force: true });
    },
  };
}

function wsUrl(gateway: RunningBrowserGateway): string {
  return `${gateway.url.replace("http", "ws")}/ws`;
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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
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
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    // `initialize` is real app-server protocol, but the BFF owns that
    // handshake. A tab must not be able to reach it.
    const response = await tab.call("initialize", { protocolVersion: 1 });
    assert.ok(response.error, "initialize must not be proxied from a browser tab");
    assert.equal(response.error.code, -32601);

    // Browser permissions are user-global. Keeping this legacy per-thread RPC
    // unreachable prevents one conversation from silently diverging from the
    // Settings value applied to every current and future thread.
    const permissionOverride = await tab.call("thread/permission/set", {
      threadId: "not-relevant",
      permissionMode: "strict",
    });
    assert.ok(permissionOverride.error, "thread/permission/set must not be proxied from a browser tab");
    assert.equal(permissionOverride.error.code, -32601);

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("a reconnecting tab resumes from its cursor with no gap and no duplicates", async () => {
  // Two turns, run on demand. The tab disconnects between them, so the second
  // turn's events are produced while nobody is listening — exactly the case
  // `afterSequence` exists for.
  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
    await input.eventSink({ type: "assistant.message.completed", text: input.prompt, timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: input.prompt,
      timestamp: timestamp(),
    });
    return engineResult(input.prompt);
  });

  try {
    const first = await TabClient.open(wsUrl(stack.gateway));
    await first.waitFor(() => first.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    const started = await first.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    await first.call("turn/start", { threadId, prompt: "first" });
    await first.waitFor(
      () => first.notifications.filter((n) => n.method === "turn/completed").length === 1,
      "first turn/completed",
    );
    const cursor = first.state[threadId]!.latestSequence;
    assert.ok(cursor > 0, "the client cursor never advanced");
    first.close();

    // The agent keeps working while the browser is away.
    const away = await TabClient.open(wsUrl(stack.gateway));
    await away.waitFor(() => away.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    await away.call("thread/resume", { threadId, subscribe: true, afterSequence: 0 });
    await away.call("turn/start", { threadId, prompt: "second" });
    await away.waitFor(
      () => away.notifications.some((n) => n.method === "turn/completed"),
      "second turn/completed",
    );
    away.close();

    // The original tab comes back holding its old cursor.
    const resumed = await TabClient.open(wsUrl(stack.gateway));
    await resumed.waitFor(() => resumed.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    resumed.state = first.state; // The browser keeps its transcript across a socket drop.
    const result = await resumed.call("thread/resume", { threadId, subscribe: true, afterSequence: cursor });

    assert.equal(result.result.replay.truncated, false, "a live ring should not report truncation");
    await resumed.waitFor(
      () => (resumed.state[threadId]?.turns.length ?? 0) === 2,
      "the missed turn to arrive by replay",
    );

    // No gap: both turns present. No duplicates: exactly one agentMessage each,
    // and the replayed events did not re-apply the ones already folded in.
    const turns = resumed.state[threadId]!.turns;
    assert.equal(turns.length, 2, "expected exactly the two turns, no duplicates");
    const texts = turns.map((turn) => {
      const message = turn.items.find((item) => item.type === "agentMessage");
      return message?.type === "agentMessage" ? message.text : undefined;
    });
    assert.deepEqual(texts, ["first", "second"], "replay produced the wrong transcript");

    resumed.close();
  } finally {
    await stack.stop();
  }
});

test("a cursor older than the replay ring reports truncation and history is refetched", async () => {
  // A one-event ring guarantees truncation on the second event — the same state
  // an app-server restart produces, without needing to restart one.
  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
    await input.eventSink({ type: "assistant.message.completed", text: input.prompt, timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: input.prompt,
      timestamp: timestamp(),
    });
    return engineResult(input.prompt);
  }, { maxReplayEvents: 1 });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    await tab.call("turn/start", { threadId, prompt: "aged out" });
    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "turn/completed"),
      "turn/completed",
    );
    tab.close();

    const resumed = await TabClient.open(wsUrl(stack.gateway));
    await resumed.waitFor(() => resumed.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    // A cursor of 1 is older than the ring's earliest surviving sequence.
    const result = await resumed.call("thread/resume", { threadId, subscribe: true, afterSequence: 1 });

    assert.equal(result.result.replay.truncated, true, "a stale cursor must report truncation");
    await resumed.waitFor(
      () => resumed.notifications.some(
        (n) => n.method === "warning" && n.params.code === "replay_truncated",
      ),
      "the replay_truncated warning",
    );

    // Truncated is not "not live": the subscription is established regardless,
    // and the fallback is journal history, which `thread/turns/list` serves.
    const page = await resumed.call("thread/turns/list", { threadId, limit: 100 });
    const history = hydrateFromTurns(emptyThreads(), threadId, page.result.data);
    const items = history[threadId]!.turns.flatMap((turn) => turn.items);
    const message = items.find((item) => item.type === "agentMessage");
    assert.equal(
      message?.type === "agentMessage" ? message.text : undefined,
      "aged out",
      "history could not be rebuilt after truncation",
    );

    resumed.close();
  } finally {
    await stack.stop();
  }
});

test("a mid-turn model change applies to the next turn, not the running one", async () => {
  // Each turn records the provider/model it was handed. The running turn's
  // profile is resolved before the change lands, so if the change bled into it
  // this list would show the new model against the first turn.
  const seen: Array<{ provider?: string; model?: string }> = [];
  let releaseFirst: (() => void) | undefined;
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });

  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    seen.push({ ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}) });
    await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: timestamp() });
    if (seen.length === 1) {
      signalFirstStarted?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    await input.eventSink({ type: "assistant.message.completed", text: input.prompt, timestamp: timestamp() });
    await input.eventSink({
      type: "turn.completed",
      runId: input.turnId,
      sessionId: input.threadId,
      assistantMessage: input.prompt,
      timestamp: timestamp(),
    });
    return engineResult(input.prompt);
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    const started = await tab.call("thread/start", {
      permissionMode: "yolo",
      subscribe: true,
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    const threadId = started.result.thread.id;

    await tab.call("turn/start", { threadId, prompt: "first" });
    await firstStarted;

    const changed = await tab.call("thread/model/set", {
      threadId,
      provider: "deepseek",
      model: "deepseek-chat",
    });
    assert.equal(changed.result.turnInFlight, true, "a running turn should be reported as in flight");
    assert.equal(
      changed.result.appliesTo,
      "nextTurn",
      "the server must say the change lands on the next turn, not this one",
    );

    // Every tab on the thread learns, not just the one that asked.
    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "thread/model/updated"),
      "thread/model/updated",
    );
    assert.equal(tab.state[threadId]?.model, "deepseek-chat", "the client store did not fold the change");

    releaseFirst?.();
    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "turn/completed"),
      "the first turn to finish",
    );

    await tab.call("turn/start", { threadId, prompt: "second" });
    await tab.waitFor(() => seen.length === 2, "the second turn to start");

    assert.equal(seen[0]?.model, "claude-opus-4-8", "the running turn's model was changed underneath it");
    assert.equal(seen[1]?.model, "deepseek-chat", "the next turn did not pick up the new model");
    assert.equal(seen[1]?.provider, "deepseek");

    tab.close();
  } finally {
    releaseFirst?.();
    await stack.stop();
  }
});

test("reasoning effort persists and reports honest next-request/next-turn semantics", async () => {
  let releaseFirst: (() => void) | undefined;
  const seen: Array<string | undefined> = [];
  const stack = await harness(async (input) => {
    seen.push(input.reasoningEffort);
    if (seen.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    return engineResult(input.prompt);
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");
    const started = await tab.call("thread/start", {
      provider: "openai",
      model: "gpt-5",
      subscribe: true,
    });
    const threadId = started.result.thread.id;

    const idle = await tab.call("thread/effort/set", { threadId, reasoningEffort: "high" });
    assert.equal(idle.result.appliesTo, "nextRequest");
    assert.equal(idle.result.turnInFlight, false);

    await tab.call("turn/start", { threadId, prompt: "first" });
    await tab.waitFor(() => seen.length === 1, "first effort-aware turn");
    assert.equal(seen[0], "high");

    const active = await tab.call("thread/effort/set", { threadId, reasoningEffort: "low" });
    assert.equal(active.result.appliesTo, "nextTurn");
    assert.equal(active.result.turnInFlight, true);

    releaseFirst?.();
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "turn/completed"), "first turn completion");
    await tab.call("turn/start", { threadId, prompt: "second" });
    await tab.waitFor(() => seen.length === 2, "second effort-aware turn");
    assert.equal(seen[1], "low");

    const read = await tab.call("thread/read", { threadId });
    assert.equal(read.result.thread.reasoningEffort, "low");
    tab.close();
  } finally {
    releaseFirst?.();
    await stack.stop();
  }
});

test("provider authentication is settable through the BFF and secrets never come back", async () => {
  const stack = await harness(async (input) => engineResult(input.prompt), {
    providerIntegrations: [testProviderIntegration],
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const secret = "sk-test-do-not-echo-9876";
    const saved = await tab.call("provider/auth/api/set", {
      providerId: "fixture-openai",
      methodId: "api-key",
      apiKey: secret,
    });
    assert.equal(saved.result.provider.configured, true);
    assert.equal(saved.result.provider.keyHint, "••••9876");
    // Saving now reports whether the provider actually accepts the key. The
    // fixture endpoint does not resolve, so the verdict is a failure — the
    // point is that a verdict comes back at all rather than a silent success.
    assert.ok(saved.result.health, "saving a key must return a health verdict");
    assert.equal(saved.result.health.providerId, "fixture-openai");
    assert.ok(saved.result.health.status !== "ok");

    const rechecked = await tab.call("provider/auth/check", { providerId: "fixture-openai" });
    assert.equal(rechecked.result.health.providerId, "fixture-openai");

    const listed = await tab.call("provider/credentials/list", {});
    const catalog = await tab.call("provider/list", {});

    // The strongest form of the assertion: nothing the browser has received
    // over this socket, by any route, contains the key.
    const everything = JSON.stringify([saved, rechecked, listed, catalog, tab.notifications]);
    assert.ok(!everything.includes(secret), "the API key was echoed back to the client");

    /*
     * `defaultSelection` is what a turn runs on when neither the thread nor
     * Settings names a model. The composer shows it, so it has to be the
     * server's real answer rather than a guess — and it is derived from the
     * credential store, so it must carry ids only. The blanket assertion
     * above already proves the secret is absent; this pins the shape so a
     * future field cannot arrive here unnoticed.
     */
    const selection = catalog.result.defaultSelection;
    if (selection) {
      assert.deepEqual(
        Object.keys(selection).sort(),
        ["model", "provider"],
        "the default selection must be provider and model ids and nothing else",
      );
      assert.equal(typeof selection.provider, "string");
      assert.equal(typeof selection.model, "string");
    }

    const fixture = catalog.result.providers.find(
      (provider: { providerId: string }) => provider.providerId === "fixture-openai",
    );
    assert.equal(fixture.configured, true, "a stored key should mark the provider configured");
    assert.ok(fixture.modelCount > 0, "the catalog must report that provider's model count");
    assert.equal("models" in fixture, false, "provider/list must stay lightweight");
    // The transport verdict has to survive the browser boundary: the composer
    // and the provider list both read it to decide what can be selected, and a
    // field dropped in serialization would silently make every model look
    // runnable again.
    assert.equal(typeof fixture.runnable, "boolean");
    const models = await tab.call("provider/models/list", {
      providerId: "fixture-openai",
      limit: 1,
    });
    assert.equal(models.result.data[0].contextTokens, 16_000);
    assert.equal(models.result.total, 1);
    assert.equal(
      models.result.data[0].runnable,
      true,
      "a model on an installed transport must be reported runnable over the BFF",
    );
    assert.ok(models.result.data[0].transportNpm, "the model must name the transport it was judged against");

    const removed = await tab.call("provider/remove", { providerId: "fixture-openai" });
    assert.equal(removed.result.removed, true);
    assert.equal(removed.result.providers[0].configured, false);

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("provider OAuth start, status, and completion stay server-side through the BFF", async () => {
  const stack = await harness(async (input) => engineResult(input.prompt), {
    providerIntegrations: [testProviderIntegration],
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const started = await tab.call("provider/auth/oauth/start", {
      providerId: "fixture-openai",
      methodId: "oauth-code",
    });
    assert.equal(started.result.attempt.mode, "code");
    assert.equal(started.result.attempt.url, "https://auth.example.invalid/authorize");
    assert.match(started.result.attempt.attemptId, /^[0-9a-f-]{36}$/i);

    const pending = await tab.call("provider/auth/oauth/status", {
      attemptId: started.result.attempt.attemptId,
    });
    assert.equal(pending.result.status, "pending");

    const completed = await tab.call("provider/auth/oauth/complete", {
      attemptId: started.result.attempt.attemptId,
      code: "fixture-code",
    });
    assert.equal(completed.result.status, "complete");
    assert.equal(completed.result.provider.configured, true);
    assert.equal(completed.result.provider.authType, "oauth");
    assert.equal(completed.result.provider.accountId, "fixture@example.test");

    const listed = await tab.call("provider/list", {});
    const everything = JSON.stringify([started, pending, completed, listed, tab.notifications]);
    assert.ok(!everything.includes("fixture-access-token-never-return"), "OAuth access token reached the browser");
    assert.ok(!everything.includes("fixture-refresh-token-never-return"), "OAuth refresh token reached the browser");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("the browser gateway does not expose the inactive memory subsystem", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-web-mem-"));
  const memoryStore = new PersistentMemoryStore({ workspaceRoot: workspace, userHome: workspace });
  memoryStore.remember({
    scope: "project",
    kind: "project_fact",
    content: "uses pnpm",
    source: "agent_inferred",
    confidence: 0.8,
    tags: ["tooling"],
  });

  const stack = await harness(async () => engineResult("ok"), { memoryStore });
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    for (const [method, params] of [
      ["memory/list", { scopes: ["project"] }],
      ["memory/search", { query: "pnpm" }],
      ["memory/health", {}],
      ["memory/contradictions", {}],
      ["memory/forget", { id: "x" }],
    ] as const) {
      const blocked = await tab.call(method, params);
      assert.equal(blocked.error.code, -32601, `${method} must not be reachable from a browser tab`);
    }

    tab.close();
  } finally {
    await stack.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("background process output reaches a tab as a thread-level notification", async () => {
  const stack = await harness(async (input) => {
    const timestamp = (): string => new Date().toISOString();
    // Background output is not a turn item: it is a thread-level stream the
    // client holds in its own Output pane. The fake runner publishes the same
    // event shape the real executor emits when a backgrounded dev server
    // prints a banner.
    await input.eventSink({
      type: "background.output.delta",
      pid: 4242,
      stream: "stdout",
      text: "Local: http://localhost:5173/",
      cmd: "vite",
      timestamp: timestamp(),
    });
    await input.eventSink({
      type: "background.server.detected",
      pid: 4242,
      url: "http://localhost:5173",
      port: 5173,
      timestamp: timestamp(),
    });
    await input.eventSink({
      type: "background.output.delta",
      pid: 4242,
      stream: "system",
      text: "Process exited code=0 signal=null",
      cmd: "vite",
      timestamp: timestamp(),
    });
    return engineResult("started a dev server");
  });

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    await tab.call("turn/start", { threadId, prompt: "start the dev server" });
    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "turn/completed"),
      "turn/completed",
    );

    const deltas = tab.notifications.filter((n) => n.method === "background/outputDelta");
    const detected = tab.notifications.filter((n) => n.method === "background/serverDetected");

    // The chunk-boundary banner arrived as a stdout delta, keyed by pid and
    // carrying its command so the pane can label it without a registry.
    assert.ok(
      deltas.some(
        (n) => n.params.pid === 4242 && n.params.delta === "Local: http://localhost:5173/",
      ),
      "stdout delta was not delivered",
    );
    assert.ok(
      deltas.some((n) => n.params.pid === 4242 && n.params.stream === "system"),
      "the exit notice was not delivered",
    );
    assert.deepEqual(
      detected.map((n) => ({ url: n.params.url, port: n.params.port, pid: n.params.pid })),
      [{ url: "http://localhost:5173", port: 5173, pid: 4242 }],
      "the detected dev server was not announced",
    );

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("workspace/skills/list and workspace/extensions/list are read-only inventories", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const skills = await tab.call("workspace/skills/list", {});
    assert.ok(Array.isArray(skills.result.data), "skills/list must return a data array");
    assert.ok(Array.isArray(skills.result.errors), "skills/list must return an errors array");
    /*
     * A built-in skill *is* listed now — `codemode` ships with the product.
     * What must stay true is that the summary carries no body: this endpoint
     * answers "what can this agent do", and the body is only ever served to a
     * model through the gated `activate_skill` tool.
     */
    assert.ok(
      skills.result.data.every((entry: Record<string, unknown>) => !("body" in entry)),
      "workspace/skills/list must not leak skill bodies",
    );

    const extensions = await tab.call("workspace/extensions/list", {});
    assert.ok(Array.isArray(extensions.result.data), "extensions/list must return a data array");
    assert.ok(Array.isArray(extensions.result.errors), "extensions/list must return an errors array");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("settings/read reports restartsRequired and never carries a secret-shaped value", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const settings = await tab.call("settings/read", {});
    assert.equal(settings.result.restartsRequired, false, "app-server settings apply without a process restart");

    // Walk the whole payload for any key that looks like it should hold a
    // secret. `settings/read` is documented to never carry one; this asserts
    // the shape, not just today's known fields.
    const secretKeyPattern = /key|token|secret|password|apiKey/i;
    const offenders: string[] = [];
    const walk = (value: unknown, keyPath: string): void => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${keyPath}[${index}]`));
        return;
      }
      if (typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (secretKeyPattern.test(key) && child !== undefined && child !== null) {
            offenders.push(`${keyPath}.${key}`);
          }
          walk(child, `${keyPath}.${key}`);
        }
      }
    };
    walk(settings.result, "settings");
    assert.deepEqual(offenders, [], "settings/read carried a secret-shaped key");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("settings/write of permissionMode round-trips through settings/read", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const written = await tab.call("settings/write", { permissionMode: "strict" });
    assert.equal(written.result.permissionMode, "strict");

    const read = await tab.call("settings/read", {});
    assert.equal(read.result.permissionMode, "strict", "the write did not persist to user settings");

    const onDisk = JSON.parse(
      await readFile(path.join(stack.workspace, ".reaper", "settings.json"), "utf8"),
    ) as { runtimeTunables?: { permissionMode?: string } };
    assert.equal(
      onDisk.runtimeTunables?.permissionMode,
      "strict",
      "settings/write did not use the injected user-global settings home",
    );

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("policy/rules/write then policy/rules/read preserves order for a 3-rule list", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const rules = [
      { outcome: "deny", pattern: "rm\\s+-rf" },
      { outcome: "allow", pattern: "^git status" },
      { outcome: "deny", pattern: "curl .*\\|.*sh" },
    ];
    const written = await tab.call("policy/rules/write", { rules });
    assert.deepEqual(written.result.rules, rules, "the write response must echo the rules in file order");

    const read = await tab.call("policy/rules/read", {});
    assert.equal(read.result.fileExists, true);
    // First-match-wins in file order: reordering here would silently change
    // which rule governs a given command, so order must survive verbatim.
    assert.deepEqual(read.result.rules, rules, "rule order was not preserved");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("policy/rules/write rejects an uncompilable regex and leaves the file untouched", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const goodRules = [{ outcome: "allow", pattern: "^ls" }];
    await tab.call("policy/rules/write", { rules: goodRules });

    const badWrite = await tab.call("policy/rules/write", {
      rules: [{ outcome: "deny", pattern: "foo(" }],
    });
    assert.ok(badWrite.error, "an uncompilable regex must be rejected");
    assert.equal(badWrite.error.code, -32602);

    const read = await tab.call("policy/rules/read", {});
    assert.deepEqual(read.result.rules, goodRules, "a rejected write must not modify rules.local.md");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("policy/rules/write preserves surrounding prose around the rule block", async () => {
  const stack = await harness(async () => engineResult("ok"));
  const rulesPath = path.join(stack.workspace, "rules.local.md");
  await writeFile(
    rulesPath,
    [
      "# Local policy overrides",
      "- deny: old-pattern",
      "This file is generated in part by the settings UI.",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    await tab.call("policy/rules/write", {
      rules: [
        { outcome: "allow", pattern: "^git log" },
        { outcome: "deny", pattern: "new-pattern" },
      ],
    });

    const content = await readFile(rulesPath, "utf8");
    assert.ok(content.startsWith("# Local policy overrides\n"), "the header prose must survive the write");
    assert.ok(
      content.includes("This file is generated in part by the settings UI."),
      "the trailing prose must survive the write",
    );
    assert.ok(content.includes("- allow: ^git log"), "the new rules must be present");
    assert.ok(!content.includes("old-pattern"), "the old rule block must be replaced, not appended to");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("settings/write applies permission mode to existing threads", async () => {
  const stack = await harness(async (input) => engineResult(input.prompt));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", subscribe: true });
    const threadId = started.result.thread.id;

    const changed = await tab.call("settings/write", { permissionMode: "strict" });
    assert.equal(changed.result.permissionMode, "strict");

    const read = await tab.call("thread/read", { threadId });
    assert.equal(read.result.thread.approvalPolicy, "strict");

    await tab.waitFor(
      () => tab.notifications.some((n) => n.method === "thread/permission/updated"),
      "thread/permission/updated",
    );
    const updated = tab.notifications.find((n) => n.method === "thread/permission/updated")!;
    assert.equal(updated.params.permissionMode, "strict");
    assert.equal(updated.params.threadId, threadId);

    const next = await tab.call("thread/start", {
      title: "Created after the global permission change",
    });
    assert.equal(
      next.result.thread.approvalPolicy,
      "strict",
      "new threads did not inherit the user-global permission mode",
    );

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("methods outside the gateway allowlist are rejected even when they resemble Phase 6 RPCs", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const deleteAttempt = await tab.call("settings/delete", {});
    assert.ok(deleteAttempt.error, "settings/delete is not allowlisted and must not be reachable");
    assert.equal(deleteAttempt.error.code, -32601);

    const nukeAttempt = await tab.call("policy/rules/nuke", {});
    assert.ok(nukeAttempt.error, "policy/rules/nuke is not allowlisted and must not be reachable");
    assert.equal(nukeAttempt.error.code, -32601);

    tab.close();
  } finally {
    await stack.stop();
  }
});

/**
 * The files pane must show the *thread's* workspace, not the server's.
 *
 * This is the regression that made the UI unusable: `/api/*` closed over one
 * server-wide root, so every thread's file tree showed whatever directory the
 * app-server started in — for a dev run, the agent's own source checkout. The
 * fix routes each request through the thread's recorded `workspaceRoot`, so
 * this asserts the two directories are genuinely distinguished by content.
 */
test("REST file routes are scoped to the thread's workspace, not the server's", async () => {
  const stack = await harness(async () => engineResult("done"));
  const project = await mkdtemp(path.join(tmpdir(), "reaper-project-"));
  try {
    // A marker in each directory, so "which root answered" is unambiguous.
    await writeFile(path.join(stack.workspace, "SERVER_ROOT.md"), "server\n", "utf8");
    await writeFile(path.join(project, "THREAD_ROOT.md"), "thread\n", "utf8");

    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const title = "Work in the existing project";
    const started = await tab.call("thread/start", {
      permissionMode: "yolo",
      subscribe: true,
      workspaceRoot: project,
      title,
    });
    const threadId = started.result.thread.id;
    assert.equal(started.result.cwd, project, "thread/start did not adopt the requested workspaceRoot");
    assert.equal(started.result.thread.name, title, "the existing-project thread lost its user-facing name");

    const listed = await fetch(
      `${stack.gateway.url}/api/files?threadId=${encodeURIComponent(threadId)}&path=.`,
    );
    assert.equal(listed.status, 200);
    const names = ((await listed.json()) as { entries: Array<{ name: string }> }).entries
      .map((entry) => entry.name);
    assert.ok(names.includes("THREAD_ROOT.md"), `expected the thread's own files, got ${names.join(", ")}`);
    assert.ok(
      !names.includes("SERVER_ROOT.md"),
      "the server's workspace leaked into a thread-scoped listing",
    );

    // Reading a file that exists only in the server's root must fail through a
    // thread-scoped request — otherwise the sandbox is the wrong directory.
    const escaped = await fetch(
      `${stack.gateway.url}/api/file?threadId=${encodeURIComponent(threadId)}&path=SERVER_ROOT.md`,
    );
    assert.equal(escaped.status, 404, "a file outside the thread's root was served");
    // `not_found`, not `workspace_missing`: the thread's root is fine, it is
    // the requested file that does not exist inside it.
    assert.equal(((await escaped.json()) as { error: string }).error, "not_found");

    // An unknown thread must not fall back to the server root: answering with
    // the wrong workspace looks like success and is worse than a 404.
    const unknown = await fetch(`${stack.gateway.url}/api/files?threadId=does-not-exist&path=.`);
    assert.equal(unknown.status, 404);

    tab.close();
  } finally {
    await rm(project, { recursive: true, force: true });
    await stack.stop();
  }
});

/**
 * `newWorkspace` gives a thread a directory of its own.
 *
 * Opt-in by design: the CLI and the fixtures all mean "work where I am", so
 * the default must stay the server's root. This pins both halves of that
 * contract, since silently relocating existing callers would change what their
 * threads operate on.
 */
test("thread/start honours newWorkspace and leaves the default alone", async () => {
  const stack = await harness(async () => engineResult("done"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const freshTitle = "Build the provider settings";
    const fresh = await tab.call("thread/start", {
      permissionMode: "yolo",
      newWorkspace: true,
      title: freshTitle,
    });
    const freshRoot = fresh.result.cwd as string;
    assert.notEqual(freshRoot, stack.workspace, "newWorkspace reused the server's workspace");
    assert.equal(fresh.result.thread.name, freshTitle, "thread/start did not return the user's title");
    assert.ok(
      freshRoot.includes(fresh.result.thread.id),
      `the thread's directory should be named for it, got ${freshRoot}`,
    );

    const listed = await tab.call("thread/list", { limit: 100 });
    const listedFresh = (listed.result.data as Array<{ id: string; name?: string }>)
      .find((entry) => entry.id === fresh.result.thread.id);
    assert.equal(listedFresh?.name, freshTitle, "thread/list did not persist the user's title");

    // Two threads must not share a directory, or their files and journals
    // would interleave.
    const second = await tab.call("thread/start", { permissionMode: "yolo", newWorkspace: true });
    assert.notEqual(second.result.cwd, freshRoot, "two fresh threads shared one directory");

    const defaulted = await tab.call("thread/start", { permissionMode: "yolo" });
    assert.equal(defaulted.result.cwd, stack.workspace, "the default stopped being the server's root");

    // An explicit root is the more specific request and wins over the flag.
    const explicit = await tab.call("thread/start", {
      permissionMode: "yolo",
      newWorkspace: true,
      workspaceRoot: stack.workspace,
    });
    assert.equal(explicit.result.cwd, stack.workspace, "an explicit workspaceRoot lost to newWorkspace");

    tab.close();
  } finally {
    await rm(path.join(homedir(), ".reaper", "workspaces"), { recursive: true, force: true })
      .catch(() => undefined);
    await stack.stop();
  }
});

/**
 * A thread's Diff tab must show the work the agent did in it.
 *
 * A fresh thread workspace is a fresh git repo, so every file written into it
 * is *untracked* — and plain `git diff` reports nothing for untracked files.
 * That would leave the Diff tab empty through an entire session of real work,
 * which reads as "the agent changed nothing" rather than "this view cannot see
 * new files". The route registers untracked paths with `--intent-to-add`, so
 * this asserts a newly written file actually appears as an addition.
 */
test("git diff surfaces newly created files in a thread's own workspace", async () => {
  const stack = await harness(async () => engineResult("done"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", newWorkspace: true });
    const threadId = started.result.thread.id as string;
    const root = started.result.cwd as string;

    // Empty repo, nothing written yet: an empty diff, not an error.
    const before = await fetch(
      `${stack.gateway.url}/api/git/diff?threadId=${encodeURIComponent(threadId)}`,
    );
    assert.equal(before.status, 200);
    assert.equal(((await before.json()) as { diff: string }).diff, "");

    await writeFile(path.join(root, "created.ts"), "export const value = 1;\n", "utf8");

    const after = await fetch(
      `${stack.gateway.url}/api/git/diff?threadId=${encodeURIComponent(threadId)}`,
    );
    const { diff } = (await after.json()) as { diff: string };
    assert.match(diff, /created\.ts/, `the new file is missing from the diff:\n${diff}`);
    assert.match(diff, /\+export const value = 1;/, `the added line is missing:\n${diff}`);

    // `--intent-to-add` records the path but must not stage its contents: the
    // index belongs to the user, and a read-only view must not commit-stage
    // their work behind their back. A staged addition would show as `A ` here.
    const { stdout: indexState } = await promisify(execFile)(
      "git",
      ["status", "--porcelain=v1"],
      { cwd: root },
    );
    assert.match(indexState, /^ A|^ M/m, `contents were staged, not just intent-to-add:\n${indexState}`);

    tab.close();
  } finally {
    await rm(path.join(homedir(), ".reaper", "workspaces"), { recursive: true, force: true })
      .catch(() => undefined);
    await stack.stop();
  }
});

/**
 * A thread outlives its directory, and the panes must say so.
 *
 * Deleting or moving a thread's folder is ordinary — but the raw failure was a
 * 500 whose body carried the app-server's absolute path, and the pane rendered
 * it as an empty tree. Neither is right: the browser should not learn the
 * server's layout, and "this is broken" should not look like "nothing here".
 */
test("a thread whose workspace was deleted reports workspace_missing, not a server path", async () => {
  const stack = await harness(async () => engineResult("done"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const started = await tab.call("thread/start", { permissionMode: "yolo", newWorkspace: true });
    const threadId = started.result.thread.id as string;
    await rm(started.result.cwd as string, { recursive: true, force: true });

    const response = await fetch(
      `${stack.gateway.url}/api/files?threadId=${encodeURIComponent(threadId)}&path=.`,
    );
    assert.equal(response.status, 404, "a missing folder is not a server fault");
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "workspace_missing");
    assert.ok(
      !body.error.includes("/"),
      `the error leaked a filesystem path to the browser: ${body.error}`,
    );

    tab.close();
  } finally {
    await rm(path.join(homedir(), ".reaper", "workspaces"), { recursive: true, force: true })
      .catch(() => undefined);
    await stack.stop();
  }
});

/**
 * Always-on skills cross the browser boundary as *names*, never as content.
 *
 * That distinction is the whole security story of the feature and is why it is
 * asserted here rather than only in a unit test: the RPC could plausibly have
 * been built to accept a body, and if it ever were, a tab would be able to put
 * arbitrary text into every subsequent prompt on this machine. Names are
 * references resolved server-side against skills that already passed the
 * project-trust gate, so the worst a hostile name can do is fail to match.
 */
test("settings/write pins skills by name, and unpinning is a real write", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    const pinned = await tab.call("settings/write", { pinnedSkills: ["codemode"] });
    assert.deepEqual(pinned.result.pinnedSkills, ["codemode"]);

    const read = await tab.call("settings/read", {});
    assert.deepEqual(read.result.pinnedSkills, ["codemode"], "the pin did not persist");

    // The write path revalidates against the config schema, so what lands on
    // disk is what the turn path will read.
    const onDisk = JSON.parse(
      await readFile(path.join(stack.workspace, ".reaper", "settings.json"), "utf8"),
    ) as { runtimeTunables?: { pinnedSkills?: string[] } };
    assert.deepEqual(onDisk.runtimeTunables?.pinnedSkills, ["codemode"]);

    // Whitespace and duplicates are normalised before the file is written, so
    // the browser's view and the turn path's view cannot disagree.
    const messy = await tab.call("settings/write", { pinnedSkills: [" codemode ", "codemode", "   "] });
    assert.deepEqual(messy.result.pinnedSkills, ["codemode"], "blank and duplicate names must not reach the file");

    const cleared = await tab.call("settings/write", { pinnedSkills: [] });
    assert.deepEqual(cleared.result.pinnedSkills, [], "an empty list must mean 'pin nothing', not 'change nothing'");

    tab.close();
  } finally {
    await stack.stop();
  }
});

test("settings/write refuses an unbounded or oversized pin list", async () => {
  const stack = await harness(async () => engineResult("ok"));
  try {
    const tab = await TabClient.open(wsUrl(stack.gateway));
    await tab.waitFor(() => tab.notifications.some((n) => n.method === "browser/ready"), "browser/ready");

    // Every pin costs its body on every future turn, so the list is bounded at
    // the protocol edge rather than left to a well-behaved client.
    const tooMany = await tab.call("settings/write", {
      pinnedSkills: Array.from({ length: 51 }, (_, i) => `skill-${i}`),
    });
    assert.ok(tooMany.error, "a 51-name pin list must be refused, not truncated");

    const tooLong = await tab.call("settings/write", { pinnedSkills: ["x".repeat(201)] });
    assert.ok(tooLong.error, "a 201-character skill name must be refused");

    // And the refusal is a refusal: nothing reached the file.
    const after = await tab.call("settings/read", {});
    assert.deepEqual(after.result.pinnedSkills, [], "a rejected write must not have persisted anything");

    tab.close();
  } finally {
    await stack.stop();
  }
});
