/**
 * A second takeover does not strand the first takeover's listeners.
 *
 * The pane's Take control button is behind a poll, so `take` can arrive twice for
 * one handoff: a double press, or a reconnect that re-posts the action. The
 * listeners that record navigations were held in a single field, so the second
 * `beginHumanControl` overwrote the closure that detached the first pair. The
 * first `page.on("framenavigated")` and `context.on("page")` then stayed attached
 * for the life of the runtime, holding the page and the context with them, and
 * nothing could ever remove them. Every later navigation was recorded twice.
 *
 * Two parts, because the failure is a wiring shape and a drain:
 *
 *   1. the drain is exercised directly and must be idempotent, since `end` and
 *      `release` can both run for one handoff, and
 *   2. the source has to hold the detachers in a list and push to it, which is
 *      what makes a second takeover cumulative rather than a leak.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ThreadBrowserRuntime } from "../../../../src/browser/thread-runtime.js";

/** The private surface this test reaches into, named so the casts stay honest. */
interface HandoffInternals {
  handoffListeners: Array<() => void>;
  disposeHandoffListeners(): void;
}

const internals = (runtime: ThreadBrowserRuntime): HandoffInternals =>
  runtime as unknown as HandoffInternals;

test("disposing the handoff listeners runs every detacher, once", () => {
  const runtime = new ThreadBrowserRuntime({ threadId: "t-h1", cdpUrl: "ws://127.0.0.1:1/devtools" });
  const detached: string[] = [];
  internals(runtime).handoffListeners.push(
    () => detached.push("first"),
    () => detached.push("second"),
  );

  internals(runtime).disposeHandoffListeners();
  assert.deepEqual(detached, ["first", "second"], "both takes must be undone, not only the last one");
});

test("disposing twice is a no-op, because end and release can both run", () => {
  /*
   * `endHumanControl` disposes, and so does `release` when a runtime is torn down
   * while the human still holds control. Whichever runs second must not detach
   * the same listener again, which Playwright answers by throwing on an unknown
   * handler or by removing somebody else's.
   */
  const runtime = new ThreadBrowserRuntime({ threadId: "t-h2", cdpUrl: "ws://127.0.0.1:1/devtools" });
  let calls = 0;
  internals(runtime).handoffListeners.push(() => {
    calls += 1;
  });

  internals(runtime).disposeHandoffListeners();
  internals(runtime).disposeHandoffListeners();
  assert.equal(calls, 1, "a second dispose must find nothing left to detach");
  assert.deepEqual(internals(runtime).handoffListeners, [], "and must leave the list empty");
});

const runtimeSource = await readFile(new URL("../../../../src/browser/thread-runtime.ts", import.meta.url), "utf8");

test("a takeover pushes its detacher rather than replacing the previous one", () => {
  assert.match(
    runtimeSource,
    /this\.handoffListeners\.push\(\(\) => \{/,
    "assigning to a single field is the leak: the earlier detacher becomes unreachable",
  );
  assert.doesNotMatch(
    runtimeSource,
    /this\.handoffListeners = \(\) => \{/,
    "the old assignment shape must be gone, not merely joined by a push",
  );
});

test("releasing the runtime detaches the handoff listeners too", () => {
  /*
   * Retire or close can land while the human has control. The closures hold the
   * page and the context, so leaving them attached keeps both alive past
   * `resetHandles` and leaves listeners running against a browser this runtime no
   * longer drives.
   */
  const at = runtimeSource.indexOf("private async release");
  assert.ok(at !== -1, "release must exist");
  const body = runtimeSource.slice(at, at + 7000);
  assert.match(body, /this\.disposeHandoffListeners\(\);/, "release must detach them with the other handles");
});
