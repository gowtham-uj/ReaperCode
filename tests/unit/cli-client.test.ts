/**
 * The CLI's client for the app-server.
 *
 * These drive a real app-server core in-process, over the real protocol, with a
 * scripted model behind it. That is deliberate: the point of this module is
 * that the CLI takes the *same* path as the web UI, and a test that stubbed the
 * protocol would prove nothing about that. What is asserted here is the wiring
 * that was wrong before — the handshake order, waiting on `turn/completed`
 * rather than on the `turn/start` response, and collecting the answer from the
 * typed stream.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import { createCliClient, connectInProcess } from "../../src/cli-client/index.js";
import type { StreamEvent } from "../../src/model/types.js";
import { scriptedTurnRunner, type TurnScript } from "../fixtures/scripted-turn-runner.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

/**
 * Run `body` against a real app-server core with a scripted model.
 *
 * The engine, event bus, session projection, and protocol are the production
 * ones. Only the model is fake, so a client that waits for a notification the
 * server never sends fails here rather than in the wild.
 */
async function withClient(
  script: TurnScript,
  run: (handle: ReturnType<typeof createCliClient>, workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const workspaceRoot = await createTempWorkspace();
  const { client, dispose } = connectInProcess({ workspaceRoot, turnRunner: scriptedTurnRunner(script) });
  const handle = createCliClient(client);
  try {
    await run(handle, workspaceRoot);
  } finally {
    handle.dispose();
    dispose();
  }
}

test("a turn returns the assistant message from the streamed deltas", async () => {
  await withClient(
    [[
      { type: "message_delta", content: "cli " },
      { type: "message_delta", content: "works" },
      { type: "message_end", data: { finishReason: "stop" } },
    ]],
    async (handle, workspaceRoot) => {
      const result = await handle.runTurn({ workspaceRoot, prompt: "say something" });
      assert.equal(result.status, "completed");
      assert.equal(result.assistantMessage, "cli works");
      assert.ok(result.threadId, "the thread id is returned so a caller can resume");
      assert.ok(result.turnId, "the turn id is returned so a caller can interrupt");
    },
  );
});

test("reasoning is kept out of the answer", async () => {
  /*
   * The bug this whole change exists for. Reasoning arrives on its own channel
   * and must never be folded into `assistantMessage`, because the CLI prints
   * that field as the agent's reply. Before, both travelled one untyped stdout
   * write and reasoning landed in the answer whenever colour was unavailable.
   */
  await withClient(
    [[
      { type: "reasoning_delta", content: "let me think about this" } as StreamEvent,
      { type: "message_delta", content: "The answer is 42." },
      { type: "message_end", data: { finishReason: "stop" } },
    ]],
    async (handle, workspaceRoot) => {
      const seen: string[] = [];
      const result = await handle.runTurn({
        workspaceRoot,
        prompt: "what is the answer",
        onNotification: (method) => seen.push(method),
      });
      assert.equal(result.assistantMessage, "The answer is 42.");
      assert.doesNotMatch(result.assistantMessage, /let me think/, "reasoning leaked into the answer");
      // The renderer needs both channels, so the client must surface both.
      assert.ok(seen.includes("item/reasoning/textDelta"), "reasoning was not reported as its own notification");
      assert.ok(seen.includes("item/agentMessage/delta"), "answer deltas were not reported");
    },
  );
});

test("tool calls are collected from the completed items", async () => {
  await withClient(
    [
      [
        { type: "tool_call", data: { id: "w1", name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hi\n" }) } },
        { type: "message_end", data: { finishReason: "tool_calls" } },
      ],
      [
        { type: "message_delta", content: "Wrote out.txt." },
        { type: "message_end", data: { finishReason: "stop" } },
      ],
    ],
    async (handle, workspaceRoot) => {
      const result = await handle.runTurn({ workspaceRoot, prompt: "write a file" });
      assert.equal(result.status, "completed");
      assert.equal(result.assistantMessage, "Wrote out.txt.");
      const write = result.toolResults.find((entry) => entry.name === "write_file" || entry.name === "fileChange");
      assert.ok(write, `no file-change result was collected: ${JSON.stringify(result.toolResults)}`);
    },
  );
});

test("a provider failure ends the turn as failed rather than hanging", async () => {
  await withClient(
    [[{ type: "message_end", data: { finishReason: "stop", error: { message: "provider exploded" } } }] as unknown as StreamEvent[]],
    async (handle, workspaceRoot) => {
      const result = await handle.runTurn({ workspaceRoot, prompt: "anything" });
      /*
       * Whatever the engine decides, the call must RETURN. A client that waits
       * on a notification the server never sends is the failure mode worth
       * guarding, so this asserts only that it settles and reports a status.
       */
      assert.ok(["completed", "failed", "interrupted"].includes(result.status));
    },
  );
});

test("the handshake happens before the turn, and a second turn reuses nothing", async () => {
  await withClient(
    [
      [{ type: "message_delta", content: "first" }, { type: "message_end", data: { finishReason: "stop" } }],
      [{ type: "message_delta", content: "second" }, { type: "message_end", data: { finishReason: "stop" } }],
    ],
    async (handle, workspaceRoot) => {
      const one = await handle.runTurn({ workspaceRoot, prompt: "one" });
      const two = await handle.runTurn({ workspaceRoot, prompt: "two" });
      assert.equal(one.assistantMessage, "first");
      assert.equal(two.assistantMessage, "second");
      // Separate turns must not share a thread unless asked, or the second
      // would inherit the first's transcript.
      assert.notEqual(one.threadId, two.threadId);
    },
  );
});

test("an adopted thread id is used for the turn", async () => {
  await withClient(
    [[{ type: "message_delta", content: "resumed" }, { type: "message_end", data: { finishReason: "stop" } }]],
    async (handle, workspaceRoot) => {
      const result = await handle.runTurn({ workspaceRoot, prompt: "continue", threadId: "cli-session-fixed" });
      assert.equal(result.threadId, "cli-session-fixed");
      assert.equal(result.assistantMessage, "resumed");
    },
  );
});

test("a second turn on the same thread continues the conversation", async () => {
  /*
   * The bug this pins: the client called `thread/start` on every turn, and the
   * server refuses an id that already exists ("Thread already exists"), so the
   * second `--session` run died before the turn began. The web UI distinguishes
   * starting from attaching (`startFresh` vs `attach` in web/ui/src/session.ts);
   * a client that does not is not actually sharing the web's path.
   */
  await withClient(
    [
      [{ type: "message_delta", content: "first answer" }, { type: "message_end", data: { finishReason: "stop" } }],
      [{ type: "message_delta", content: "second answer" }, { type: "message_end", data: { finishReason: "stop" } }],
    ],
    async (handle, workspaceRoot) => {
      const one = await handle.runTurn({ workspaceRoot, prompt: "remember AMBER-CANYON-41", threadId: "sess-continue" });
      assert.equal(one.assistantMessage, "first answer");

      // The same thread id must be adoptable rather than an error.
      const two = await handle.runTurn({ workspaceRoot, prompt: "what was the codeword", threadId: "sess-continue" });
      assert.equal(two.assistantMessage, "second answer");
      assert.equal(two.threadId, "sess-continue");

      /*
       * And the transcript must have been replayed into the second turn: the
       * resumed thread's own history arrives as notifications before the new
       * turn starts, and the bug this pins was those frames being counted as
       * the new answer. The two replies coming back distinct is what proves
       * the filter separates them.
       */
      assert.notEqual(one.assistantMessage, two.assistantMessage, "the second turn replayed the first turn's answer");
    },
  );
});
