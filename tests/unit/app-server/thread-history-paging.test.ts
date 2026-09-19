/**
 * A thread's first page is bounded, and the rest is reachable.
 *
 * Opening a thread used to transfer its entire history before anything could be
 * drawn, so the wait grew with the conversation while the visible work stayed the
 * same: the reader is looking at the end. Resume now carries the newest turns and
 * says whether older ones exist.
 *
 * The bound is only honest if the rest can be fetched, which is the half that is
 * easy to build and forget: the server side of this shipped first, and the client
 * had a loader nothing called. These tests pin both halves and the contract
 * between them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const src = (relative: string): Promise<string> =>
  readFile(new URL(`../../../${relative}`, import.meta.url), "utf8");

test("resume answers with a tail and says whether more exists", async () => {
  const protocol = await src("src/app-server/protocol.ts");
  assert.match(protocol, /turnsLimit/, "the client must be able to bound the page");
  assert.match(protocol, /max\(200\)/, "and the bound must itself be bounded");

  const processor = await src("src/app-server/message-processor.ts");
  assert.match(
    processor,
    /allTurns\.slice\(Math\.max\(0, allTurns\.length - params\.turnsLimit\)\)/,
    "the page must be the NEWEST turns, not the oldest",
  );
  assert.match(processor, /hasOlderTurns:/, "and the elision must be stated, not silent");
});

test("the client offers a way to reach the older turns", async () => {
  /*
   * The half that was missing. A bounded page with no way to load the rest makes
   * a thread look shorter than it is, which is worse than the slow load it
   * replaced.
   */
  const session = await src("web/ui/src/session.ts");
  assert.match(session, /loadOlderTurns/, "the session must expose a loader");
  assert.match(session, /sortDirection: "desc"/, "paging must walk backwards from the newest turn, or 'older' fetches the thread's start");

  const app = await src("web/ui/src/App.tsx");
  assert.match(app, /loadOlderTurns\(\)/, "and a control must call it");
  assert.match(app, /hasOlderTurns &&/, "shown only when there is something to load");
});

test("paging resets when the thread changes", async () => {
  /*
   * A cursor is a position in one thread. Carried across a switch it would fold
   * one conversation's turns into another's, which is the same leak the composer
   * draft and the queue had before they were keyed to a thread.
   */
  const session = await src("web/ui/src/session.ts");
  assert.match(session, /resetHistoryWindow/, "the paging position must be resettable");
  const resets = [...session.matchAll(/resetHistoryWindow\(\)/g)].length;
  assert.ok(resets >= 3, `both entry points must reset it (found ${resets} uses)`);
});
