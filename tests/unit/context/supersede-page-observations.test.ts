/**
 * Dropping the page from a browser result a later result replaced.
 *
 * The cost this exists for was measured: one `browser_use` result carried
 * 262,631 characters of accessibility tree, and because a tool result stays in
 * the conversation it was re-sent with every later call until something
 * compacted it. The facts in that result are still wanted; the page is not, once
 * the model has looked again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { supersedePageObservations } from "../../../src/context/supersede-page-observations.js";

/** A browser result the way the tool writes one. */
function browserResult(page: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "tool",
    name: "browser_use",
    timestamp: 1_000,
    content: JSON.stringify({
      output: `OUTCOME: SUCCESS\nREV 4 -> 5\nelapsed 120ms\n\nchanged: 2 lines\n\nPAGE:\n${page}`,
      outcome: "SUCCESS",
      rev: 5,
      surface: { url: "https://x", title: "t", interactive: [] },
      ...extra,
    }),
  };
}

const bigPage = "REV 5\nURL: https://x\n" + "- link \"item\" [ref=e1]\n".repeat(400);

test("older page text is dropped, the facts are kept", () => {
  const messages = [browserResult(bigPage, { marker: "old" }), browserResult("REV 6\nsmall", { marker: "new" })];
  const result = supersedePageObservations(messages, { keepRecent: 1, minPageChars: 500 });

  assert.equal(result.superseded, 1, "the older result is superseded");
  assert.ok(result.savedChars > 5_000, "and a lot of characters go with it");

  const kept = JSON.parse(String(messages[0]!.content)) as Record<string, unknown>;
  const output = String(kept["output"]);
  assert.match(output, /OUTCOME: SUCCESS/, "the outcome survives");
  assert.match(output, /REV 4 -> 5/, "the revision transition survives");
  assert.match(output, /changed: 2 lines/, "what the action did survives");
  assert.match(output, /page text dropped/, "and the page is marked as dropped");
  assert.ok(!output.includes("item"), "the page lines themselves are gone");
});

test("the most recent results are untouched", () => {
  const messages = [browserResult(bigPage), browserResult(bigPage), browserResult(bigPage)];
  supersedePageObservations(messages, { keepRecent: 2, minPageChars: 100 });

  const last = String(messages[2]!.content);
  assert.ok(last.includes("item"), "the newest page is intact");
  const middle = String(messages[1]!.content);
  assert.ok(middle.includes("item"), "and so is the one before it");
});

test("a short result is left alone", () => {
  // The benefit only exists for the big ones, and being conservative means never
  // losing text a model might have wanted.
  const short = browserResult("REV 5\n(no change)");
  const messages = [short, browserResult("REV 6\nnew")];
  const result = supersedePageObservations(messages, { keepRecent: 1 });
  assert.equal(result.superseded, 0);
  assert.ok(String(messages[0]!.content).includes("no change"));
});

test("the surface copy goes with the page", () => {
  // Two copies of a superseded page is double the waste this pass removes.
  const messages = [browserResult(bigPage), browserResult("REV 6\nsmall")];
  supersedePageObservations(messages, { keepRecent: 1, minPageChars: 500 });
  const kept = JSON.parse(String(messages[0]!.content)) as Record<string, unknown>;
  assert.equal(kept["surface"], undefined, "the structured copy is dropped too");
});

test("it is idempotent", () => {
  // The pass runs on every model call, so running it again must not double-count
  // or re-trim.
  const messages = [browserResult(bigPage), browserResult("REV 6\nsmall")];
  const first = supersedePageObservations(messages, { keepRecent: 1, minPageChars: 500 });
  const second = supersedePageObservations(messages, { keepRecent: 1, minPageChars: 500 });
  assert.ok(first.superseded > 0);
  assert.equal(second.superseded, 0, "nothing left to supersede");
  assert.equal(second.savedChars, 0, "and nothing double-counted");
});

test("a non-browser tool result is never touched", () => {
  const messages = [
    { role: "tool", name: "read_file", timestamp: 1, content: JSON.stringify({ output: `PAGE:\n${bigPage}` }) },
    browserResult("REV 6\nsmall"),
  ];
  const result = supersedePageObservations(messages, { keepRecent: 1, minPageChars: 100 });
  assert.equal(result.superseded, 0, "only browser results are considered");
  assert.ok(String(messages[0]!.content).includes("item"));
});

test("a result that is not the expected envelope is skipped, not guessed at", () => {
  const messages = [
    { role: "tool", name: "browser_use", timestamp: 1, content: "not json at all, but marked PAGE:" + bigPage },
    browserResult("REV 6\nsmall"),
  ];
  const result = supersedePageObservations(messages, { keepRecent: 1, minPageChars: 100 });
  assert.equal(result.superseded, 0, "an unparseable result is left exactly as it is");
});
