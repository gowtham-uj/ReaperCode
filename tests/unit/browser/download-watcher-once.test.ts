/**
 * One page, one download listener.
 *
 * A page reaches `watchDownloads` from two places that do not know about each
 * other: the runtime's attach loop over the context's pages, and `adoptPopup`,
 * which is the path `expectPopup` takes once its own wait fires. Both run for the
 * same popup, so the page was wired twice and every download after it was handled
 * twice: the vault collapsed the two copies into one file, but the transcript and
 * the ledger saw two, which reads as a download that happened twice.
 *
 * Checked with a fake page rather than a live browser, because what went wrong is
 * the number of listeners and that is observable without one. A page that has
 * been through this must answer with exactly one `download` handler, and a page
 * that has not must still get its own, which is what says the guard is keyed on
 * the page rather than being a global "already wired" flag.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { watchDownloads, type VaultFile } from "../../../src/browser/downloads.js";

interface FakePage {
  on(event: string, handler: (download: unknown) => void): void;
  emit(event: string, download: unknown): void;
  count(event: string): number;
}

function fakePage(): FakePage {
  const handlers = new Map<string, Array<(download: unknown) => void>>();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit(event, download) {
      for (const handler of handlers.get(event) ?? []) handler(download);
    },
    count(event) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

const noStore = async (): Promise<VaultFile | undefined> => undefined;

test("wiring the same page twice attaches one download listener", () => {
  const page = fakePage();
  const collected: VaultFile[] = [];

  watchDownloads(page as never, noStore, collected);
  watchDownloads(page as never, noStore, collected);

  assert.equal(page.count("download"), 1, "a second call must not add a second handler");
});

test("one download reaches the store once, not twice", async () => {
  /*
   * The listener count is the mechanism; the double copy is the consequence, and
   * this pins the consequence so the test still means something if the wiring is
   * refactored.
   */
  const page = fakePage();
  const collected: VaultFile[] = [];
  let calls = 0;
  const store = async (): Promise<VaultFile | undefined> => {
    calls += 1;
    return { name: "invoice.txt", path: "/vault/invoice.txt", bytes: 13, mtimeMs: Date.now() };
  };

  watchDownloads(page as never, store, collected);
  watchDownloads(page as never, store, collected);

  page.emit("download", { suggestedFilename: () => "invoice.txt" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls, 1, "the page's store must run once per download");
  assert.equal(collected.length, 1, "and the transcript must carry one entry");
});

test("a different page still gets its own listener", () => {
  /*
   * The guard is per page. A global "already wired" flag would pass the test
   * above and silently leave every other page in the thread with no watcher,
   * which is the original twenty-minute bug in reverse: a download nobody
   * listens for is discarded by Playwright.
   */
  const first = fakePage();
  const second = fakePage();
  const collected: VaultFile[] = [];

  watchDownloads(first as never, noStore, collected);
  watchDownloads(second as never, noStore, collected);

  assert.equal(first.count("download"), 1, "the first page is wired");
  assert.equal(second.count("download"), 1, "and so is the second, which the guard must not have swallowed");
});
