import test from "node:test";
import assert from "node:assert/strict";

import { SessionProjection } from "../../src/app-server/session-projection.js";
import type { ThreadEventRecord } from "../../src/app-server/event-bus.js";
import type { ThreadMetadata } from "../../src/app-server/thread-store.js";
import {
  applyNotification,
  deriveSteps,
  emptyThreads,
  isExplorationItem,
  isExplorationStep,
  summarizeExplorationStep,
  summarizeItem,
  summarizeToolArgs,
  type ThreadsState,
} from "../../web/shared/src/index.js";

/**
 * Drift insurance for the two reducers.
 *
 * The server folds RuntimeEvents into `AppThread` state (`SessionProjection`);
 * the browser folds the *notifications* that projection emits into its own copy
 * (`web/shared/thread-store`). They must land in the same place — otherwise the
 * UI silently renders a transcript the server does not agree with. This test
 * runs one representative event sequence through both and compares the result.
 */

const NOW = "2026-08-27T00:00:00.000Z";
const THREAD_ID = "parity";
const TURN_ID = "turn-1";

const metadata: ThreadMetadata = {
  version: 1,
  threadId: THREAD_ID,
  sessionName: "app-parity",
  workspaceRoot: "/tmp/workspace",
  permissionMode: "yolo",
  status: "idle",
  createdAt: NOW,
  updatedAt: NOW,
  title: "Parity",
};

function withTs<T extends { type: string }>(event: T): T & { timestamp: string } {
  return { ...event, timestamp: NOW };
}

/** Events chosen to cover every branch the client reducer implements. */
function eventSequence(): Array<{ event: ThreadEventRecord["event"]; turnId?: string }> {
  return [
    { event: withTs({ type: "thread.started", threadId: THREAD_ID }) },
    { event: withTs({ type: "turn.user.message", threadId: THREAD_ID, turnId: TURN_ID, text: "Fix the race" }), turnId: TURN_ID },
    { event: withTs({ type: "turn.started", runId: TURN_ID, sessionId: THREAD_ID }), turnId: TURN_ID },
    { event: withTs({ type: "assistant.reasoning.delta", text: "checking auth" }), turnId: TURN_ID },
    { event: withTs({ type: "assistant.message.delta", text: "I'll " }), turnId: TURN_ID },
    { event: withTs({ type: "assistant.message.delta", text: "inspect it." }), turnId: TURN_ID },
    { event: withTs({ type: "tool.started", toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } } }), turnId: TURN_ID },
    { event: withTs({ type: "command.output.delta", toolCallId: "bash-1", stream: "stdout", text: "README.md\n" }), turnId: TURN_ID },
    {
      event: withTs({
        type: "tool.completed",
        toolCall: { id: "bash-1", name: "bash", args: { cmd: "ls" } },
        result: { name: "bash", toolCallId: "bash-1", ok: true, durationMs: 1, output: { stdout: "README.md\n", exitCode: 0 } },
      }),
      turnId: TURN_ID,
    },
    { event: withTs({ type: "assistant.message.completed", text: "I'll inspect it." }), turnId: TURN_ID },
    { event: withTs({ type: "token.usage", inputTokens: 100, outputTokens: 20 }), turnId: TURN_ID },
    {
      event: withTs({ type: "turn.completed", runId: TURN_ID, sessionId: THREAD_ID, assistantMessage: "I'll inspect it." }),
      turnId: TURN_ID,
    },
  ];
}

function runBothReducers(): {
  server: SessionProjection;
  client: ThreadsState;
  methods: string[];
} {
  const projection = new SessionProjection();
  let client = emptyThreads();
  const methods: string[] = [];
  let sequence = 0;

  for (const step of eventSequence()) {
    sequence += 1;
    const notifications = projection.project(
      {
        sequence,
        timestamp: NOW,
        threadId: THREAD_ID,
        ...(step.turnId ? { turnId: step.turnId } : {}),
        event: step.event,
      },
      metadata,
    );
    for (const note of notifications) {
      methods.push(note.method);
      client = applyNotification(client, note.method, note.params);
    }
  }

  return { server: projection, client, methods };
}

test("client reducer lands on the same items as the server projection", () => {
  const { client, methods } = runBothReducers();

  // Guard the fixture itself: if the projection stops emitting these, the
  // comparison below would pass vacuously.
  for (const method of [
    "thread/started",
    "turn/started",
    "item/started",
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/commandExecution/outputDelta",
    "item/completed",
    "thread/tokenUsage/updated",
    "turn/completed",
  ]) {
    assert.ok(methods.includes(method), `projection never emitted ${method}; got ${methods.join(", ")}`);
  }

  const clientThread = client[THREAD_ID];
  assert.ok(clientThread, "client reducer never created the thread");

  const clientTurn = clientThread.turns.find((turn) => turn.id === TURN_ID);
  assert.ok(clientTurn, "client reducer never created the turn");

  // `turn/completed` carries the server's authoritative item list — the client
  // must agree with it in both membership and order.
  const serverItems = lastCompletedTurnItems();
  assert.ok(serverItems.length > 0, "server turn had no items; the comparison below would be vacuous");
  assert.deepEqual(
    clientTurn.items.map((item) => ({ id: item.id, type: item.type })),
    serverItems.map((item) => ({ id: item.id, type: item.type })),
  );
  assert.equal(clientTurn.status, "completed");
});

/** Re-runs the sequence and returns the item list from `turn/completed`. */
function lastCompletedTurnItems(): Array<{ id: string; type: string }> {
  const projection = new SessionProjection();
  let items: Array<{ id: string; type: string }> = [];
  let sequence = 0;
  for (const step of eventSequence()) {
    sequence += 1;
    const notifications = projection.project(
      {
        sequence,
        timestamp: NOW,
        threadId: THREAD_ID,
        ...(step.turnId ? { turnId: step.turnId } : {}),
        event: step.event,
      },
      metadata,
    );
    for (const note of notifications) {
      if (note.method !== "turn/completed") continue;
      const turn = note.params.turn as { items: Array<{ id: string; type: string }> };
      items = turn.items;
    }
  }
  return items;
}

test("client reducer accumulates streamed text exactly as the server does", () => {
  const { client } = runBothReducers();
  const turn = client[THREAD_ID]?.turns.find((entry) => entry.id === TURN_ID);
  assert.ok(turn);

  const agent = turn.items.find((item) => item.type === "agentMessage");
  assert.equal(agent?.type === "agentMessage" ? agent.text : undefined, "I'll inspect it.");

  const reasoning = turn.items.find((item) => item.type === "reasoning");
  assert.deepEqual(reasoning?.type === "reasoning" ? reasoning.content : undefined, ["checking auth"]);

  const command = turn.items.find((item) => item.type === "commandExecution");
  assert.equal(
    command?.type === "commandExecution" ? command.aggregatedOutput : undefined,
    "README.md\n",
  );
});

test("client reducer mirrors cumulative token usage", () => {
  const { client } = runBothReducers();
  const usage = client[THREAD_ID]?.tokenUsage;
  assert.deepEqual(usage?.total, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
  assert.deepEqual(usage?.last, { inputTokens: 100, outputTokens: 20, totalTokens: 120 });
});

test("latestSequence tracks the highest sequence seen, for reconnect cursors", () => {
  const { client } = runBothReducers();
  const thread = client[THREAD_ID];
  assert.ok(thread);
  assert.equal(thread.latestSequence, eventSequence().length);
});

test("applyNotification returns new objects along the mutated path only", () => {
  const before = applyNotification(
    applyNotification(emptyThreads(), "thread/started", {
      threadId: "a",
      sequence: 1,
      thread: { id: "a" },
    }),
    "thread/started",
    { threadId: "b", sequence: 1, thread: { id: "b" } },
  );

  const after = applyNotification(before, "item/agentMessage/delta", {
    threadId: "a",
    turnId: "t1",
    itemId: "msg-1",
    sequence: 2,
    delta: "hi",
  });

  assert.notEqual(after.a, before.a, "the touched thread must be a new object");
  assert.equal(after.b, before.b, "an untouched thread must keep its identity");
});

test("deriveSteps splits a turn at each model hand-back after a tool call", () => {
  const steps = deriveSteps({
    id: "turn-1",
    status: "completed",
    items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "go" }] },
      { type: "reasoning", id: "r1", summary: [], content: ["look"] },
      { type: "commandExecution", id: "c1", command: "ls", status: "completed" },
      { type: "commandExecution", id: "c2", command: "cat x", status: "completed" },
      { type: "agentMessage", id: "m1", text: "now editing", phase: "commentary" },
      { type: "fileChange", id: "f1", changes: [{ path: "a.ts", kind: "modify" }], status: "completed" },
      { type: "agentMessage", id: "m2", text: "done", phase: "final_answer" },
    ],
  });

  assert.deepEqual(
    steps.map((step) => step.items.map((item) => item.id)),
    [["u1", "r1", "c1", "c2"], ["m1", "f1"], ["m2"]],
  );
});

test("deriveSteps keeps a tool-free turn as a single step", () => {
  const steps = deriveSteps({
    id: "turn-2",
    status: "completed",
    items: [
      { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }] },
      { type: "reasoning", id: "r1", summary: [], content: ["thinking"] },
      { type: "agentMessage", id: "m1", text: "hello", phase: "final_answer" },
    ],
  });
  assert.equal(steps.length, 1);
});

test("exploration tool names all exist in the real tool registry", async () => {
  // The collapse rule keys off tool names. When I first wrote it I invented
  // names ("read_file", "grep", "ls") that no longer exist — read_file was
  // removed outright. This test fails if any classified name leaves the
  // registry, rather than letting the UI silently stop collapsing.
  const { toolRegistry } = await import("../../src/tools/registry.js");
  const known = new Set(Object.keys(toolRegistry));

  const classified = [
    "file_view", "file_scroll", "file_find", "view_file", "skim_file",
    "list_directory", "grep_search", "glob", "git_status", "git_diff",
    "search_memory", "search_tools", "get_tool_output",
    "read_background_output", "inspect_environment", "diagnostics",
  ];
  for (const tool of classified) {
    assert.ok(known.has(tool), `"${tool}" is classified as exploration but is not a registered tool`);
    assert.ok(isExplorationItem(toolItem(tool)), `"${tool}" should classify as exploration`);
  }
});

test("mutating tools are never classified as collapsible exploration", () => {
  // Wrong in the safe direction: an unclassified tool stays visible.
  for (const tool of ["bash", "write_file", "file_edit", "delete_file", "apply_patch_edit", "some_new_tool"]) {
    assert.equal(isExplorationItem(toolItem(tool)), false, `"${tool}" must not collapse`);
  }
});

test("a step mixing exploration with an edit stays expanded", () => {
  const explorationOnly = {
    id: "s1",
    items: [toolItem("file_view"), toolItem("grep_search")],
  };
  assert.equal(isExplorationStep(explorationOnly), true);

  const mixed = { id: "s2", items: [toolItem("file_view"), toolItem("write_file")] };
  assert.equal(isExplorationStep(mixed), false, "one write must keep the whole step visible");

  assert.equal(isExplorationStep({ id: "s3", items: [] }), false, "an empty step is not collapsible");
});

test("item summaries use the CLI's label vocabulary", () => {
  assert.deepEqual(
    summarizeItem({ type: "commandExecution", id: "c1", command: "npm test", status: "completed" }),
    { label: "Ran", detail: "npm test" },
  );
  assert.deepEqual(
    summarizeItem({
      type: "fileChange",
      id: "f1",
      changes: [{ path: "src/auth.ts", kind: "modify" }],
      status: "completed",
    }),
    { label: "Edited", detail: "src/auth.ts" },
  );
  assert.deepEqual(
    summarizeItem({
      type: "dynamicToolCall",
      id: "t1",
      tool: "grep_search",
      arguments: { pattern: "TODO", path: "src" },
      status: "completed",
    }),
    { label: "grep_search", detail: "TODO in src" },
  );
});

test("long commands truncate but stay identifiable", () => {
  const long = `echo ${"x".repeat(200)}`;
  const { detail } = summarizeItem({ type: "commandExecution", id: "c1", command: long, status: "completed" });
  assert.ok(detail.length < 90, "must truncate");
  assert.ok(detail.startsWith("echo xxx"), "must keep the identifying head of the command");
  assert.ok(detail.endsWith("…"), "must signal that it was cut");
});

test("an unrecognized tool still summarizes to something identifiable", () => {
  assert.equal(
    summarizeToolArgs("a_tool_invented_next_year", { path: "src/new.ts", verbose: true }),
    "src/new.ts",
  );
  assert.equal(summarizeToolArgs("opaque_tool", { flag: true }), "");
});

test("exploration step label pluralizes", () => {
  assert.equal(summarizeExplorationStep(1), "1 exploration action");
  assert.equal(summarizeExplorationStep(7), "7 exploration actions");
});

function toolItem(tool: string) {
  return { type: "dynamicToolCall", id: `call-${tool}`, tool, arguments: {}, status: "completed" } as const;
}
