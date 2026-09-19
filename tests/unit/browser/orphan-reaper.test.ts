/**
 * The orphan reaper's rules, which are all about what it must NOT close.
 *
 * Closing a page that belonged to a live thread would throw away a half-finished
 * form or a cart, which is the exact state the persistent browser exists to
 * keep. So the interesting cases are the refusals.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOwnedTargetIds, sweepOrphanPages } from "../../../src/browser/orphan-reaper.js";

const workspace = async (): Promise<string> => mkdtemp(join(tmpdir(), "reap-"));

/**
 * Every thread name these tests write a record for, treated as live.
 *
 * The sweep only counts a file whose thread still exists, and that is the fix
 * this suite now covers from both sides: `LIVE_ALL` is the "nothing was deleted"
 * case, and the test below is the "the owner is gone" case.
 */
const LIVE_ALL: ReadonlySet<string> = new Set(["thread-a", "thread-b", "good", "keep-owner"]);

const writeOwnerFile = async (root: string, name: string, ids: string[], names?: Record<string, string>): Promise<void> => {
  const dir = join(root, ".reaper", "browser");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.pages-owner.json`), JSON.stringify({ version: 1, targetIds: ids, names: names ?? {} }));
};

/** A stand-in browser with pages that answer Target.getTargetInfo. */
function fakeBrowser(ids: Array<string | undefined>): { browser: never; closed: string[] } {
  const closed: string[] = [];
  const pages = ids.map((id, i) => ({
    isClosed: () => false,
    close: async () => { closed.push(id ?? `unknown-${i}`); },
  }));
  const context = {
    pages: () => pages,
    newCDPSession: async (page: unknown) => {
      const index = pages.indexOf(page as never);
      return {
        send: async (): Promise<unknown> => ({ targetInfo: { targetId: ids[index] } }),
        detach: async () => undefined,
      };
    },
  };
  return { browser: { contexts: () => [context] } as never, closed };
}

test("ids are read from every owner file in the workspace", async () => {
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["A1", "A2"]);
  await writeOwnerFile(root, "thread-b", ["B1"]);
  const owned = await readOwnedTargetIds(root, LIVE_ALL);
  assert.deepEqual([...owned].sort(), ["A1", "A2", "B1"]);
});

test("a file left by a deleted thread owns nothing", async () => {
  /*
   * The bug, directly. Every owner file was read regardless of whether its
   * thread still existed, so a deleted thread's pages were counted as owned and
   * were permanently immune to the sweep. Measured on a live machine: a
   * `drop-test` file outlived its thread record, and the pages it named were never
   * closed, so the browser accumulated them until an attach was slow enough to
   * look like a hang.
   *
   * The dead file is asserted to be ignored while the live one is still honoured,
   * because the failure this guards against has two halves: litter being kept,
   * and a real claim being dropped.
   */
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["LIVE-1"]);
  await writeOwnerFile(root, "deleted-thread", ["STALE-1", "STALE-2"]);

  const owned = await readOwnedTargetIds(root, new Set(["thread-a"]));
  assert.deepEqual([...owned], ["LIVE-1"], "only a thread that still exists owns anything");

  // And the consequence, end to end: the stale pages are closed.
  const { browser, closed } = fakeBrowser(["LIVE-1", "STALE-1", "STALE-2"]);
  const result = await sweepOrphanPages(browser, owned);
  assert.equal(result.kept, 1, "the live thread's page is kept");
  assert.deepEqual([...closed].sort(), ["STALE-1", "STALE-2"], "and the dead thread's pages are closed");
});

test("a corrupt record owns nothing and does not break the pass", async () => {
  const root = await workspace();
  await writeOwnerFile(root, "good", ["A1"]);
  const dir = join(root, ".reaper", "browser");
  await writeFile(join(dir, "bad.pages-owner.json"), "{ this is not json");
  const owned = await readOwnedTargetIds(root, LIVE_ALL);
  assert.deepEqual([...owned], ["A1"]);
});

test("an owned page is kept", async () => {
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["KEEP", "ORPHAN", "OTHER"]);
  const { browser, closed } = fakeBrowser(["KEEP", "ORPHAN", "OTHER"]);
  const result = await sweepOrphanPages(browser, await readOwnedTargetIds(root, LIVE_ALL));
  assert.equal(result.closed, 0);
  assert.equal(result.kept, 3);
  assert.deepEqual(closed, []);
});

test("a page no record names is closed", async () => {
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["KEEP1", "KEEP2"]);
  // Two owned, one stranger: the stranger goes and the others stay. The last
  // page is never closed, so keep two so the sweep has room to act.
  const { browser, closed } = fakeBrowser(["KEEP1", "KEEP2", "STRANGER"]);
  const result = await sweepOrphanPages(browser, await readOwnedTargetIds(root, LIVE_ALL));
  assert.deepEqual(closed, ["STRANGER"]);
  assert.equal(result.closed, 1);
  assert.equal(result.kept, 2);
});

test("no ownership records means nothing is closed", async () => {
  /*
   * A workspace with no records is a fresh install or a cleared state
   * directory, not a browser full of orphans. Closing everything there would
   * throw away work to solve a problem that does not exist.
   */
  const root = await workspace();
  const { browser, closed } = fakeBrowser(["A", "B", "C"]);
  const result = await sweepOrphanPages(browser, await readOwnedTargetIds(root, LIVE_ALL));
  assert.deepEqual(closed, []);
  assert.equal(result.closed, 0);
  assert.match(result.errors.join(" "), /no ownership records/i);
});

test("the last page is never closed", async () => {
  /*
   * A context with no pages is a state Steel's viewer does not render, and the
   * next attach finds nothing to adopt: it looks like a broken browser rather
   * than an empty one.
   */
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["SOMETHING-ELSE"]);
  const { browser, closed } = fakeBrowser(["ONLY-STRANGER"]);
  await sweepOrphanPages(browser, await readOwnedTargetIds(root, LIVE_ALL));
  assert.deepEqual(closed, [], "the only page must survive");
});

test("a page whose id cannot be read is kept", async () => {
  /*
   * "Cannot tell" is not "nobody owns it". Closing something unidentified is the
   * one mistake this could make that loses work.
   */
  const root = await workspace();
  await writeOwnerFile(root, "thread-a", ["KEEP1", "KEEP2"]);
  const { browser, closed } = fakeBrowser(["KEEP1", "KEEP2", undefined]);
  const result = await sweepOrphanPages(browser, await readOwnedTargetIds(root, LIVE_ALL));
  assert.deepEqual(closed, []);
  assert.equal(result.kept, 3);
});
