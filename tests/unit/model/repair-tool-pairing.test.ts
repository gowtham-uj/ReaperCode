/**
 * The provider's tool-call pairing rule, and the repair that enforces it.
 *
 * Every case here is a conversation that would be rejected with:
 *
 *   HTTP 400 — An assistant message with 'tool_calls' must be followed by
 *   tool messages responding to each 'tool_call_id'.
 *
 * The tests assert both halves of the invariant: an unanswered call gets a
 * result it can be paired with, and a tool message nothing announced is
 * dropped, because the two failures have different repairs.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { pairingWasRepaired, repairToolCallPairing } from "../../../src/model/repair-tool-pairing.js";

const call = (id: string, name = "bash") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

test("a well-formed conversation is returned unchanged", () => {
  const messages = [
    { role: "user", content: "run it" },
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "tool", content: "output", tool_call_id: "a", name: "bash" },
    { role: "assistant", content: "done" },
  ];
  const result = repairToolCallPairing(messages);
  assert.equal(pairingWasRepaired(result), false);
  assert.deepEqual(result.messages, messages, "an already-valid conversation must pass through verbatim");
});

test("an unanswered tool call gets a synthetic result, and the announcement survives", () => {
  /*
   * This is the shape the user hit. History is rebuilt from the journal with
   * `content.trim().length > 0 || tool_calls`, so a tool result with empty
   * output is filtered out while the assistant message that called it stays.
   * The pair is then broken on the wire.
   *
   * The repair must keep the assistant message: it is history the model wrote,
   * and dropping it would delete the only record that it asked for something.
   * The synthetic result says the output is missing without claiming the call
   * failed, because the repair cannot know which.
   */
  const result = repairToolCallPairing([
    { role: "user", content: "write the file" },
    { role: "assistant", content: "", tool_calls: [call("call-1", "write_file")] },
    { role: "user", content: "are you there?" },
  ]);

  assert.equal(pairingWasRepaired(result), true);
  assert.equal(result.synthesised.length, 1);
  assert.equal(result.synthesised[0]?.toolCallId, "call-1");
  assert.equal(result.synthesised[0]?.toolName, "write_file");

  const repaired = result.messages.find((m) => m.role === "tool") as
    | { tool_call_id?: string; content?: unknown; is_error?: boolean }
    | undefined;
  assert.ok(repaired, "a tool message must be synthesised");
  assert.equal(repaired.tool_call_id, "call-1");
  assert.match(String(repaired.content), /No result was recorded/);
  assert.match(String(repaired.content), /write_file/);
  assert.equal(repaired.is_error, true);

  // The announcement is still there, immediately before its answer.
  const announcement = result.messages.find((m) => m.role === "assistant");
  assert.ok(announcement && (announcement.tool_calls?.length ?? 0) === 1);
  const order = result.messages.map((m) => m.role);
  assert.deepEqual(order, ["user", "assistant", "tool", "user"], "the synthetic result goes directly after the call it answers");
});

test("only the unanswered calls in a batch are repaired", () => {
  // A partial batch is the realistic case: three calls, one result lost.
  const result = repairToolCallPairing([
    { role: "assistant", content: "", tool_calls: [call("a"), call("b"), call("c")] },
    { role: "tool", content: "first", tool_call_id: "a" },
    { role: "tool", content: "third", tool_call_id: "c" },
  ]);

  assert.deepEqual(result.synthesised.map((s) => s.toolCallId), ["b"]);
  assert.equal(result.dropped, 0);
  const ids = result.messages
    .filter((m) => m.role === "tool")
    .map((m) => (m as { tool_call_id?: string }).tool_call_id);
  assert.deepEqual(ids, ["a", "b", "c"], "the original results keep their order and the repair fills the gap");
});

test("a tool message nothing announced is dropped rather than kept", () => {
  /*
   * The other direction, and it cannot be repaired by inventing a call. A tool
   * result the provider cannot attribute to a call is itself a protocol error,
   * so the only safe repair is removal.
   */
  const result = repairToolCallPairing([
    { role: "user", content: "hi" },
    { role: "tool", content: "orphaned output", tool_call_id: "ghost" },
  ]);

  assert.equal(pairingWasRepaired(result), true);
  assert.equal(result.dropped, 1);
  assert.equal(result.synthesised.length, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.role, "user");
});

test("a tool message with no tool_call_id at all is dropped", () => {
  const result = repairToolCallPairing([
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "tool", content: "nameless" },
  ]);
  assert.equal(result.dropped, 1);
  // And the announced call is still answered by synthesis.
  assert.deepEqual(result.synthesised.map((s) => s.toolCallId), ["a"]);
});

test("unanswered calls are repaired when a new assistant turn begins", () => {
  /*
   * The boundary matters. A provider pairs within the run of messages that
   * follows one assistant turn, so an id left unanswered when the next
   * assistant turn starts cannot be satisfied later — and attributing it to
   * the wrong turn is exactly what the error complains about.
   */
  const result = repairToolCallPairing([
    { role: "assistant", content: "", tool_calls: [call("old")] },
    { role: "assistant", content: "never mind, I did it myself" },
    { role: "user", content: "ok" },
  ]);

  assert.deepEqual(result.synthesised.map((s) => s.toolCallId), ["old"]);
  const order = result.messages.map((m) => m.role);
  assert.deepEqual(order, ["assistant", "tool", "assistant", "user"], "the synthetic result lands before the turn that follows");
});

test("an assistant message with no tool calls is left alone", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const result = repairToolCallPairing(messages);
  assert.equal(pairingWasRepaired(result), false);
  assert.deepEqual(result.messages, messages);
});

test("the input array is never mutated", () => {
  // Passes share message arrays, so a repair that edited in place would be
  // visible to whichever pass ran next.
  const messages = [
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "user", content: "next" },
  ];
  const snapshot = JSON.parse(JSON.stringify(messages)) as unknown;
  const before = messages.length;
  repairToolCallPairing(messages);
  assert.equal(messages.length, before, "no message may be pushed into the caller's array");
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), snapshot);
});

test("an empty conversation is a no-op", () => {
  const result = repairToolCallPairing([]);
  assert.deepEqual(result.messages, []);
  assert.equal(pairingWasRepaired(result), false);
});

/*
 * A tool call with no id is the case that produced the live DeepSeek 400,
 * "Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'".
 *
 * The repair used to filter id-less calls out when building its pending list
 * but then push the assistant message unchanged, so the id-less entry reached
 * the wire still carrying a call nothing could answer — and `pairingWasRepaired`
 * returned false, so the gateway sent it believing it was already valid. Every
 * call must leave with an id, and a call assigned one must be answerable like
 * any other.
 */
test("a tool call with no id is given one and answered", () => {
  const messages = [
    { role: "user", content: "go" },
    // An id-less call, as a provider or a trimmed history can produce.
    { role: "assistant", content: "", tool_calls: [{ type: "function" as const, function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", content: "output", tool_call_id: "", name: "bash" },
    { role: "assistant", content: "done" },
  ];

  const result = repairToolCallPairing(messages);
  assert.equal(pairingWasRepaired(result), true, "an id-less call must count as repaired");
  assert.equal(result.idAssigned, 1);

  const assistant = result.messages[1] as { tool_calls?: Array<{ id?: string }> };
  const assignedId = assistant.tool_calls?.[0]?.id;
  assert.ok(assignedId && assignedId.length > 0, "every announced call must carry an id after repair");

  // The wire must now be a valid pairing: the assistant announces an id and a
  // tool message answers that exact id.
  const toolMessage = result.messages.find((m) => m.role === "tool") as { tool_call_id?: string } | undefined;
  assert.equal(toolMessage?.tool_call_id, assignedId, "the tool result must answer the assigned id");
});

test("an unanswered id-less call still gets an id and a synthetic result", () => {
  const messages = [
    { role: "assistant", content: "", tool_calls: [{ type: "function" as const, function: { name: "file_view", arguments: "{}" } }] },
    { role: "user", content: "next" },
  ];
  const result = repairToolCallPairing(messages);
  assert.equal(result.idAssigned, 1, "the id-less call must be given an id");
  assert.equal(result.synthesised.length, 1, "and then answered, since no result arrived");
  const roles = result.messages.map((m) => m.role);
  assert.deepEqual(roles, ["assistant", "tool", "user"], "the synthetic answer lands before the following turn");
});

test("a mixed batch assigns ids only where they are missing", () => {
  const messages = [
    { role: "assistant", content: "", tool_calls: [call("c1"), { type: "function" as const, function: { name: "file_view", arguments: "{}" } }] },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "bash" },
  ];
  const result = repairToolCallPairing(messages);
  assert.equal(result.idAssigned, 1, "only the id-less call is assigned one");
  const assistant = result.messages[0] as { tool_calls: Array<{ id: string }> };
  assert.equal(assistant.tool_calls[0]?.id, "c1", "the real id is preserved");
  assert.ok(assistant.tool_calls[1]?.id, "the missing id is filled in");
});

/*
 * A batch whose results arrive out of announcement order must not be repaired
 * into an orphan.
 *
 * This is the live failure. One assistant message announced six calls
 * (`c0..c5`) and the results arrived `c0,c1,c2,c4,c5,c3`. The old repair
 * emitted results as they came and, seeing `c3` still unanswered when `c4`
 * arrived, inserted a synthetic result for it — then the real `c3` followed and
 * had no announcing assistant nearby that the provider would pair it with, so
 * DeepSeek rejected the whole request: "Messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'". The repair was creating
 * the violation it exists to prevent. Resolving the batch as a whole, a call
 * with a real result must never also get a synthetic one.
 */
test("a batch with results out of order is left valid, not repaired into an orphan", () => {
  const ids = ["c0", "c1", "c2", "c3", "c4", "c5"];
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: ids.map((id) => call(id)) },
    // c3 arrives last, after c4 and c5.
    ...[...ids.filter((id) => id !== "c3"), "c3"].map((id) => ({
      role: "tool", content: `result-${id}`, tool_call_id: id, name: "bash",
    })),
    { role: "assistant", content: "done" },
  ];

  const result = repairToolCallPairing(messages);
  assert.equal(result.synthesised.length, 0, "a call with a real result must not also get a synthetic one");
  assert.equal(result.dropped, 0, "the out-of-order result must not be dropped as an orphan");

  // The output must satisfy the provider's rule: every tool answers its
  // preceding assistant, and no announced call is left unanswered.
  const out = result.messages as Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }> }>;
  let open: Set<string> | null = null;
  for (const m of out) {
    if (m.role === "assistant" && m.tool_calls?.length) { open = new Set(m.tool_calls.map((c) => c.id)); continue; }
    if (m.role === "tool") { assert.ok(open?.has(m.tool_call_id!), `orphan tool ${m.tool_call_id}`); open!.delete(m.tool_call_id!); continue; }
    if (open) assert.equal(open.size, 0, "a call was left unanswered before the next turn");
    open = null;
  }
});
