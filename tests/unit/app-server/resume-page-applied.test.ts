/**
 * The turns a resume carries must reach the transcript.
 *
 * `thread/resume` answers with two things: the thread's metadata, under
 * `thread`, and its newest turns, under `initialTurnsPage`. The client read the
 * first and dropped the second. `seedThread` folds the reply in through
 * `mergeThreadMetadata`, which handles sessionId, preview, cwd, model and
 * settings — and never touches `turns`, because a metadata merge has no business
 * rewriting a turn list.
 *
 * So every resume fetched the transcript's actual content, parsed it, typed it,
 * and discarded it. What a reader saw came from the replay stream alone. That
 * held together while a resume replayed every event and would have failed on a
 * reload or a reconnect where replay does not reach back far enough: the thread
 * would render short, with no error and nothing to explain the gap.
 *
 * Found by opening a completed mission: the UI showed a thread whose journal held
 * 310 messages as four elements. (The turn count itself was right — a mission is
 * one user prompt and therefore one turn; the loss was in what the page would
 * have supplied and the stream did not.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ui = (relative: string): Promise<string> =>
  readFile(new URL(`../../../web/ui/src/${relative}`, import.meta.url), "utf8");

test("the client reads initialTurnsPage from a resume", async () => {
  const session = await ui("session.ts");
  assert.match(session, /initialTurnsPage\?:/, "the reply's turn page must be typed");
  assert.match(session, /resumed\.initialTurnsPage/, "and read, not merely declared");

  // Both entry points: opening a thread, and reattaching after a reload.
  const reads = [...session.matchAll(/store\.replaceTurns\(/g)].length;
  assert.ok(reads >= 2, `both switchThread and attach must apply the page (found ${reads})`);
});

test("a fresh load takes the page and a reconnect does not", async () => {
  /*
   * The distinction the two entry points need, because they are not the same
   * situation. A reload has an empty store and needs the page. A reconnect has a
   * store the reader may have paged through, and the page is only the newest
   * thirty turns, so replacing there would throw away history they deliberately
   * loaded.
   */
  const session = await ui("session.ts");
  assert.match(
    session,
    /store\.thread\(remembered\)\?\.turns\.length \?\? 0\) === 0/,
    "attach must apply the page only when the store is empty",
  );
});

test("the store replaces turns rather than merging them", async () => {
  /*
   * Replace, because the server's page is what the thread is. A merge would keep
   * a ghost of any turn the server no longer has, which is how a compacted
   * conversation would show turns that are gone.
   */
  const store = await ui("store.ts");
  assert.match(store, /replaceTurns\(/, "the store must expose a replace path");
  assert.match(store, /const next = replaceTurns\(current, threadId, turns\)/, "and use it");
});
