/**
 * A reap must not poison the runtime a running turn is holding.
 *
 * This is the failure that ended a mission at 7/32, and it is worth writing down
 * because every part of it pointed away from the cause.
 *
 * The idle reaper decided "idle" from a map of `forThread` lookups. A turn does
 * not look its thread up per step: the browser tool holds its runtime object for
 * the whole turn, so a thread that had been browsing continuously for eighty
 * minutes still had a `lastUsed` entry that said nothing for ten. The reaper
 * retired that runtime mid-turn, which called `close()`, which closed all twelve
 * of the thread's pages. And `close()` sets `closed = true` permanently, so
 * every later `attach()` connected to a perfectly healthy browser and then threw
 * the connection away, and each of the turn's remaining calls reported
 * "the browser could not be attached".
 *
 * Measured, and reproduced before the fix:
 *
 *   this thread's pages: 1
 *   after reap -> browser pages: 0
 *   held runtime:  the browser could not be attached
 *   fresh runtime: attached on https://example.com/   <- the browser was fine
 *
 * So the two things these tests pin are the two halves of the fix: idleness is
 * measured by the runtime that is being driven, and a reap retires rather than
 * closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ThreadBrowsers } from "../../../src/app-server/thread-browsers.js";
import { ThreadBrowserRuntime } from "../../../src/browser/thread-runtime.js";

/**
 * Make a runtime without a browser.
 *
 * The pieces under test are the idle clock and the lifecycle flags, and neither
 * needs a connection: `retire` and `close` on a runtime that never attached are
 * both safe no-ops that differ only in what they leave behind.
 */
function offlineRuntime(threadId: string): ThreadBrowserRuntime {
  /*
   * A port with nothing on it, and a short attach budget to match. The default
   * 45s is right for production and makes a failing attach here cost 45s per
   * test, which is the difference between a suite and a coffee break.
   */
  return new ThreadBrowserRuntime({ threadId, cdpUrl: "ws://127.0.0.1:9", cdpTimeoutMs: 300 });
}

test("retire leaves the runtime able to attach again; close does not", async () => {
  const retired = offlineRuntime("a");
  await retired.retire();
  assert.equal(
    (retired as unknown as { closed: boolean }).closed,
    false,
    "a reap must not mark the runtime final, or a turn holding it can never re-attach",
  );

  const closed = offlineRuntime("b");
  await closed.close();
  assert.equal(
    (closed as unknown as { closed: boolean }).closed,
    true,
    "close is final: this runtime is being thrown away and must undo a late attach",
  );
});

test("an attach failure after close names the cause instead of blaming the browser", async () => {
  /*
   * The misdirection that cost the mission its last twenty calls. The model read
   * "the browser could not be attached" as "the browser has crashed" and spent
   * the rest of the run looking for a crash. The runtime knows it was closed, so
   * it has to say so.
   */
  const runtime = offlineRuntime("c");
  await runtime.close();
  await assert.rejects(
    () => runtime.ensureReady(),
    (error: Error) => {
      assert.match(error.message, /closed and cannot re-attach/, `expected a named cause, got: ${error.message}`);
      return true;
    },
  );
});

test("a retired runtime still reports the plain failure, not the closed one", async () => {
  /*
   * The negative case, and the one that matters: retiring must leave the runtime
   * in the ordinary unattached state, where a failed attach is about the browser.
   * If this said "closed" the message would be a lie in the other direction.
   */
  const runtime = offlineRuntime("d");
  await runtime.retire();
  await assert.rejects(
    () => runtime.ensureReady(),
    (error: Error) => {
      assert.doesNotMatch(error.message, /closed and cannot re-attach/);
      return true;
    },
  );
});

test("the idle clock measures use, not lookups", async () => {
  /*
   * The half of the bug that made it possible. `forThread` stamps a map, and the
   * browser tool does not call it per step, so that stamp went stale on a thread
   * that was being driven constantly. The runtime's own clock is stamped by the
   * attach path, which every step goes through.
   */
  const runtime = offlineRuntime("e");
  const first = runtime.idleForMs();

  // Reading the clock must not reset it, or the reaper would never fire.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(runtime.idleForMs() > first, "the clock advances on its own");

  /*
   * A use resets it. Asserted through `pageTargets`, which is the path the live
   * pane and the tab list take, and which stamps the clock before attempting the
   * attach: so a turn whose browser momentarily refuses is still not reaped out
   * from under itself.
   *
   * The wait is longer than the 300ms attach budget, so the assertion cannot be
   * satisfied by the failed attach happening to finish quickly. Idle time before
   * the call exceeds one attach; idle time after it is one attach at most.
   */
  await new Promise((resolve) => setTimeout(resolve, 900));
  const before = runtime.idleForMs();
  await runtime.pageTargets().catch(() => undefined);
  const after = runtime.idleForMs();
  assert.ok(after < before, `a use resets the clock: was ${before}ms, now ${after}ms`);
  assert.ok(after < 500, `the reset is to roughly now, not to the start of the attempt: ${after}ms`);
});

test("the reaper retires rather than closes, and asks the runtime how idle it is", async () => {
  /*
   * The wiring, asserted directly, because the bug was in the wiring: the reap
   * loop called `close()` and read a stale map. A stub stands in for the runtime
   * so the decision can be inspected without a browser.
   */
  const browsers = new ThreadBrowsers({
    cdpUrl: "ws://127.0.0.1:3000",
    statePathFor: (threadId) => `/tmp/idle-retire-${threadId}.json`,
  });

  const calls: string[] = [];
  let idle = 0;
  const stub = {
    idleForMs: () => idle,
    retire: async () => { calls.push("retire"); },
    close: async () => { calls.push("close"); },
  };
  const internals = browsers as unknown as { runtimes: Map<string, unknown>; reap(idleMs: number): Promise<void> };
  internals.runtimes.set("idle-thread", stub);

  // Active: not touched at all.
  idle = 0;
  await internals.reap(600_000);
  assert.deepEqual(calls, [], "a runtime used a moment ago is left alone");
  assert.equal(browsers.peek("idle-thread") !== undefined, true, "and stays held");

  // Idle past the window: retired, not closed.
  idle = 700_000;
  await internals.reap(600_000);
  assert.deepEqual(calls, ["retire"], "an idle runtime is retired, never closed");
  assert.equal(browsers.peek("idle-thread"), undefined, "and dropped from the map");

  await browsers.close();
});

test("a thread with a turn in flight is never reaped, however idle its browser", async () => {
  /*
   * The gap the activity clock cannot see. A model can reason for longer than
   * the idle window and then ask for the tabs it left open, so "the browser has
   * not been touched" is not the same as "nobody wants it". The app-server
   * answers the turn question; the reaper asks it before retiring anything.
   */
  const browsers = new ThreadBrowsers({
    cdpUrl: "ws://127.0.0.1:3000",
    statePathFor: (threadId) => `/tmp/idle-retire-${threadId}.json`,
    threadIsRunning: (threadId) => threadId === "thinking",
  });

  const calls: string[] = [];
  const stub = (threadId: string) => ({
    idleForMs: () => 10_000_000,
    retire: async () => { calls.push(`retire:${threadId}`); },
    close: async () => { calls.push(`close:${threadId}`); },
  });
  const internals = browsers as unknown as { runtimes: Map<string, unknown>; reap(idleMs: number): Promise<void> };
  internals.runtimes.set("thinking", stub("thinking"));
  internals.runtimes.set("done", stub("done"));

  await internals.reap(600_000);

  assert.deepEqual(calls, ["retire:done"], "only the thread with no turn running is retired");
  assert.equal(browsers.peek("thinking") !== undefined, true, "the thinking thread keeps its browser");
  assert.equal(browsers.peek("done"), undefined);

  await browsers.close();
});

test("retiring twice is safe, and leaves the runtime detached rather than dead", async () => {
  /*
   * A reap can land on a runtime a previous reap already retired, and a second
   * pass must be a no-op rather than a second round of closes. The property that
   * makes it safe is the same one the whole fix rests on: retiring clears the
   * handles and stops there, leaving `closed` false.
   *
   * The live counterpart, verified against the real browser: a retained runtime
   * whose pages were reaped re-attached on its next call and browsed again, while
   * a runtime that had been `close()`d could never attach at all.
   */
  const runtime = offlineRuntime("recovering");
  await runtime.retire();
  await runtime.retire();
  assert.equal((runtime as unknown as { closed: boolean }).closed, false);
  assert.equal(runtime.isAttached(), false, "detached, which is the state it recovers from");
});
