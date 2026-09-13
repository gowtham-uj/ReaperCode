/**
 * The repeated-command check must never claim an output was seen before.
 *
 * `shellOutputKey` returned `""` for any result whose `output` was not an
 * object — and on the conversation path `output` is a plain string, which is
 * what the engine holds for a tool message. So *every* bash result keyed to the
 * empty string, the first one added `""` to the seen-set, and every later one
 * was rewritten to "[same as earlier]".
 *
 * The user-visible form was a model that ran four different inspection commands
 * and read "[same as earlier]" for three of them. It then reported that bash
 * was returning cached output and switched to `eval` for reliable reads — which
 * is a correct response to a genuinely broken tool, and it was this pass doing
 * the corrupting.
 *
 * Replacing real output with a claim that it was seen before is worse than the
 * duplication the pass exists to remove, so these tests weigh the two failure
 * directions: a missed saving is acceptable, a false collapse is not.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { microcompact } from "../../../src/context/compaction/microcompact.js";
import type { ToolResult } from "../../../src/tools/types.js";

const CHARS_ABOVE_BUDGET = 30_000;

function bash(toolCallId: string, output: string): ToolResult {
  return { name: "bash", durationMs: 0, ok: true, toolCallId, output } as unknown as ToolResult;
}

test("distinct bash outputs are never collapsed, whatever their shape", () => {
  /*
   * Total size is above the 50k budget so the pass actually runs — below it the
   * function returns early and would pass this test for the wrong reason.
   */
  const results = [
    bash("s1", `{"a":1}` + "x".repeat(CHARS_ABOVE_BUDGET)),
    bash("s2", `{"b":2}` + "y".repeat(CHARS_ABOVE_BUDGET)),
    bash("s3", `{"c":3}` + "z".repeat(CHARS_ABOVE_BUDGET)),
    bash("s4", `{"d":4}` + "w".repeat(CHARS_ABOVE_BUDGET)),
  ];

  const out = microcompact({ toolResults: results });
  for (const [index, kept] of out.toolResults.entries()) {
    assert.doesNotMatch(
      String(kept.output),
      /same as earlier/,
      `result ${index + 1} of 4 was replaced with "[same as earlier]" although no other command produced it`,
    );
  }
});

test("a genuine duplicate still collapses, and only the later one", () => {
  const identical = "identical listing text" + "q".repeat(CHARS_ABOVE_BUDGET);
  const results = [
    bash("d1", identical),
    bash("d2", identical),
    bash("d3", "something else entirely" + "r".repeat(CHARS_ABOVE_BUDGET)),
  ];

  const out = microcompact({ toolResults: results });
  const collapsed = out.toolResults.filter((r) => String(r.output).includes("same as earlier"));
  assert.equal(collapsed.length, 1, "exactly the duplicate should collapse");
  assert.equal(out.toolResults[0]?.toolCallId, "d1", "the original must be the one kept");
  assert.equal(out.toolResults[1]?.toolCallId, "d2", "and the later copy is the one replaced");
  assert.match(
    String(out.toolResults[2]?.output),
    /something else entirely/,
    "an unrelated output must survive alongside a collapse",
  );
});

test("a result with nothing to compare is left alone, not treated as a duplicate", () => {
  /*
   * An empty key means "no output in a shape I understand". Two of those are
   * not the same result, so they must not be collapsed into each other — this
   * is the precise mistake that produced the bug.
   */
  const opaque = (toolCallId: string): ToolResult =>
    ({ name: "bash", durationMs: 0, ok: true, toolCallId, output: undefined } as unknown as ToolResult);
  const filler = bash("f1", "f".repeat(CHARS_ABOVE_BUDGET * 2));

  const out = microcompact({ toolResults: [opaque("o1"), opaque("o2"), filler] });
  const collapsed = out.toolResults.filter((r) => String(r.output).includes("same as earlier"));
  assert.equal(collapsed.length, 0, "results with no comparable output were collapsed into each other");
});
