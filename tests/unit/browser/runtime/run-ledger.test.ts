import { test } from "node:test";
import assert from "node:assert/strict";

import { RunLedger } from "../../../../src/browser/runtime/run-ledger.js";

test("a failed call cannot be invisible in the metrics", () => {
  /*
   * The bug this replaces: a mission summary reported failure_count 0 for a run
   * with fourteen failed calls, because the count and the browser were separate
   * things. Here the count is a fold over the same events that record the
   * failures, so there is no second number to drift.
   */
  const ledger = new RunLedger();
  ledger.record({ kind: "mission.started" });
  ledger.record({ kind: "action.finished", actionId: "a1", status: "success", durationMs: 100 });
  ledger.record({ kind: "action.finished", actionId: "a2", status: "failed", durationMs: 30_000, failureKind: "ACTION_TIMEOUT" });
  const metrics = ledger.metrics();
  assert.equal(metrics.browserCalls, 2);
  assert.equal(metrics.failedCalls, 1);
  assert.equal(metrics.timeoutFailures, 1);
  assert.equal(metrics.failuresByKind.ACTION_TIMEOUT, 1);
});

test("a download is only provenance-clean when an action raised it", () => {
  const ledger = new RunLedger();
  ledger.record({ kind: "artifact.saved", name: "invoice.txt", path: "/w/invoice.txt", bytes: 66, announced: false });
  assert.equal(ledger.downloadsFromActions().length, 0);
  ledger.record({ kind: "artifact.saved", name: "receipt.pdf", path: "/w/receipt.pdf", bytes: 12, announced: true, triggeredBy: "a117" });
  assert.equal(ledger.downloadsFromActions().length, 1);
});

test("a page opened by a click is distinguishable from one the program asked for", () => {
  const ledger = new RunLedger();
  ledger.record({ kind: "page.created", pageId: "p8", creationType: "newPage" });
  assert.equal(ledger.popupsFromActions().length, 0);
  ledger.record({ kind: "page.created", pageId: "p9", creationType: "popup", openedBy: "a152", url: "https://x" });
  assert.equal(ledger.popupsFromActions().length, 1);
  assert.equal(ledger.popupsFromActions()[0]?.openedBy, "a152");
});

test("elapsed time is the span of the events, not a wall clock read at render", () => {
  let clock = 1_000;
  const ledger = new RunLedger(() => clock);
  ledger.record({ kind: "mission.started" });
  clock = 4_500;
  ledger.record({ kind: "action.finished", actionId: "a1", status: "success", durationMs: 10 });
  clock = 61_000;
  ledger.record({ kind: "mission.finish_requested" });
  assert.equal(ledger.metrics().totalMs, 60_000);
});

test("events carry a monotonic sequence, so order survives identical timestamps", () => {
  const ledger = new RunLedger(() => 5_000);
  const first = ledger.record({ kind: "mission.started" });
  const second = ledger.record({ kind: "action.finished", actionId: "a1", status: "success", durationMs: 1 });
  assert.ok(second.seq > first.seq);
});

test("a token line appears only when a call was recorded, never as a zero", () => {
  /*
   * The browser layer does not know what the model was sent: that is core's
   * business, and this layer must stay extractable, so nothing in it records a
   * `model.call`. An unconditional line therefore read `TOKENS: 0 in / 0 out` on
   * every run, whatever the run cost.
   *
   * That is the same shape as the bug the ledger replaced. A summary reporting
   * `failure_count: 0` for fourteen failures was not wrong because a counter
   * mis-incremented; it was wrong because the number came from somewhere that
   * did not know. A zero meaning "nobody told me" is worse than no line, because
   * it reads as a cheap run.
   */
  const ledger = new RunLedger();
  ledger.record({ kind: "mission.started" });
  ledger.record({ kind: "action.finished", actionId: "a1", status: "success", durationMs: 5 });
  assert.doesNotMatch(ledger.render(), /TOKENS/, "no call was recorded, so there is no token line to print");

  /*
   * And the fold is live: a host that does know can record one and the number
   * becomes real rather than staying at zero.
   */
  ledger.record({ kind: "model.call", inputTokens: 1_200, outputTokens: 340 });
  assert.match(ledger.render(), /TOKENS: 1200 in \/ 340 out/);
});
