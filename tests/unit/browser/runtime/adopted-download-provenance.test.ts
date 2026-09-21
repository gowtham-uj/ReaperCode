/**
 * A download nobody armed still gets its provenance.
 *
 * The failure this pins was a false negative in the verifier, which is the worst
 * shape one can take: the work was done and the check said it was not.
 *
 * A program that clicks a download link without wrapping the click in
 * `download()` produces a real file through the page-level `download` listener.
 * That listener stored the file through the vault directly, so the ledger was
 * never told, and `artifactFromAction` then refused a file that a click had
 * genuinely produced. A model that did the right thing was told it had not.
 *
 * The second half is the arithmetic: the armed collector and the page listener
 * both fire for the same event, so the fix routes both through one recorder and
 * dedupes on the stored path. Two events for one download would make the metrics
 * wrong in the other direction, and a benchmark reading them would over-report.
 *
 * Source-level for the wiring, behavioural for the ledger, because the wiring is
 * what went wrong: `adopt` existed, was correct, and was called by nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { ArtifactManager } from "../../../../src/browser/runtime/artifact-manager.js";
import { DownloadVault } from "../../../../src/browser/downloads.js";
import { RunLedger } from "../../../../src/browser/runtime/run-ledger.js";

/** A download that answers what the vault asks of it, without a browser. */
function fakeDownload(name: string, bytes: string, target: string) {
  return {
    suggestedFilename: () => name,
    saveAs: async (to: string) => { await writeFile(to, bytes); void target; },
    failure: async () => null,
    url: () => `https://example.com/${name}`,
  };
}

test("an adopted download is recorded against the action that was running", async () => {
  const vault = new DownloadVault(await mkdtemp(join(tmpdir(), "adopt-")));
  const ledger = new RunLedger();
  const manager = new ArtifactManager(vault, ledger);

  const artifact = await manager.adopt({} as never, fakeDownload("invoice.txt", "invoice bytes", "") as never, "a152");

  assert.equal(artifact.name, "invoice.txt");
  assert.equal(artifact.announced, true, "an event raised by the browser is an announcement");
  const fromAction = ledger.downloadsFromActions();
  assert.equal(fromAction.length, 1, "the ledger must carry the download");
  assert.equal(fromAction[0]!.triggeredBy, "a152", "and it must name the action that caused it");
});

test("one download reached by two listeners is one ledger event", async () => {
  /*
   * The real shape: `page.on("download")` and the armed `waitForEvent("download")`
   * are two listeners on one event, so both call the manager for the same file.
   * The vault already collapses them to one stored path; this asserts the ledger
   * collapses them to one event, because the metrics fold from the ledger and two
   * events would read as two downloads.
   */
  const vault = new DownloadVault(await mkdtemp(join(tmpdir(), "dedupe-")));
  const ledger = new RunLedger();
  const manager = new ArtifactManager(vault, ledger);

  const download = fakeDownload("invoice.txt", "invoice bytes", "") as never;
  const [first, second] = await Promise.all([
    manager.adopt({} as never, download, "a1"),
    manager.adopt({} as never, download, "a1"),
  ]);

  assert.equal(first.path, second.path, "both listeners get the same stored file");
  assert.equal(ledger.downloadsFromActions().length, 1, "one download is one event, not two");
});

test("the page watcher stores through the kit, so provenance cannot be skipped", async () => {
  /*
   * Source-level, because the bug was a call that was never made: `adopt` was
   * written, was correct, and nothing invoked it. A behavioural test of the
   * listener needs a live browser; what matters and can be checked here is that
   * the runtime's watcher routes through the path that records.
   */
  const runtime = await readFile(new URL("../../../../src/browser/thread-runtime.ts", import.meta.url), "utf8");
  assert.match(
    runtime,
    /watchDownloads\(page, \(download\) => this\.kit\.adoptDownload\(page, download\)/,
    "the page watcher must go through the kit, which records provenance",
  );
  assert.doesNotMatch(
    runtime,
    /watchDownloads\(page, this\.downloads/,
    "storing straight through the vault is the bug: it copies the file and tells the ledger nothing",
  );
});

test("the download repair defers to the next attach instead of tearing down mid-step", async () => {
  /*
   * The repair closed the connection eagerly at first, and that broke a step: the
   * running step's page was detached, so the receipt's own page block reported the
   * page as unreadable and a later check about where the page is found nothing. A
   * failed download is already a failed step; wrecking the rest of the receipt is
   * the repair doing more damage than the fault.
   *
   * Checked in the source because the behaviour needs a live browser to observe.
   * What can be asserted without one is the shape that makes it safe: the flag is
   * set, and the connection is dropped in `ensureReady` rather than here.
   */
  const runtime = await readFile(new URL("../../../../src/browser/thread-runtime.ts", import.meta.url), "utf8");
  const at = runtime.indexOf("async repairDownloads()");
  assert.ok(at !== -1, "the repair must exist");
  const body = runtime.slice(at, at + 1200);
  assert.match(body, /downloadsNeedFreshConnection = true/, "it must mark the connection stale");
  assert.doesNotMatch(body, /browser\.close\(\)/, "and must NOT close the connection while the step is running");

  /*
   * Both halves of the deferred drop, and the second one was a bug of its own.
   *
   * `resetHandles` clears the reference without closing it, which leaks a live
   * socket to Steel. Node's test runner waits for the event loop to drain, so a
   * suite that passed every assertion then hung with no failing test to look at:
   * measured, the transactional file passed all twenty-two tests and never
   * exited. The repair therefore has to close the old connection, and close it at
   * the start of the next call rather than inside the failing step.
   */
  const attach = runtime.slice(runtime.indexOf("if (this.downloadsNeedFreshConnection)"));
  const block = attach.slice(0, attach.indexOf("if (!this.browser"));
  assert.match(block, /this\.resetHandles\(\)/, "the next attach drops the stale handles");
  assert.match(block, /stale\.close\(\)/, "and closes the connection, or the socket leaks and the suite hangs");
});
