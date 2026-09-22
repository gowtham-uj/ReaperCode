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
import { utimes } from "node:fs/promises";

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

/** A page whose download wait rejects, the way a timeout does. */
function pageThatNeverAnnounces(): { waitForEvent: () => Promise<never> } {
  return {
    waitForEvent: () =>
      Promise.reject(new Error('page.waitForEvent: Timeout 30000ms exceeded while waiting for event "download"')),
  };
}

test("a wait whose event never fired does not adopt an earlier download", async () => {
  /*
   * The receipt this bug made lie, and the auditor reproduced it directly.
   *
   * `newestUnclaimed` took the last entry of the vault directory with no
   * staleness filter and no sort, so when the armed wait rejected, `collect`
   * answered with whatever the thread had downloaded last and `finish` recorded
   * it against the action. A page whose `waitForEvent("download")` rejected
   * produced an artifact with `triggeredBy` set, so `artifactFromAction` passed
   * for a click that downloaded nothing.
   *
   * A stale file is exactly the shape: one download from an earlier step sits in
   * the vault, the next click produces nothing, and the old file is handed back
   * as the new one's result. The event here rejects, which is the arm timing out.
   *
   * Two stale files are used because there are two ways to be stale, and only
   * checking the first would leave the mtime filter untested. One was in the
   * vault before the arm, so `known` excludes it. The other lands while the arm
   * is outstanding with an older timestamp, which is what the mtime comparison
   * is for: the vault is inside the workspace, so a program can write into it,
   * and `cp -p` keeps the source's timestamp rather than stamping the copy.
   */
  const dir = await mkdtemp(join(tmpdir(), "stale-arm-"));
  const vault = new DownloadVault(dir);
  await vault.ensure();
  const stale = join(dir, "invoice-from-an-earlier-step.txt");
  await writeFile(stale, "invoice bytes");
  /* Older than anything this manager can have caused. */
  const when = (Date.now() - 60_000) / 1000;
  await utimes(stale, when, when);

  const ledger = new RunLedger();
  const manager = new ArtifactManager(vault, ledger);

  const token = await manager.arm(pageThatNeverAnnounces() as never);
  const planted = join(dir, "planted-during-the-arm.txt");
  await writeFile(planted, "not from this action");
  const earlier = (Date.now() - 30_000) / 1000;
  await utimes(planted, earlier, earlier);

  const artifact = await manager.collect(token, { actionId: "a7" });

  assert.equal(artifact, undefined, "no file arrived, so no artifact may be claimed");
  assert.equal((await vault.list()).length, 2, "both files are still in the vault, they are just not this action's");
  assert.equal(ledger.downloadsFromActions().length, 0, "and the ledger must record nothing");
  assert.equal(ledger.events().length, 0, "not even an unattributed artifact event");
});

test("a file that lands after the arm is still collected, and the stale one is not", async () => {
  /*
   * The other half, so requiring provenance cannot delete the fallback this
   * class exists for. The dropped-event race is real: the file lands without
   * Playwright announcing it, and answering "no download arrived" there is the
   * twenty-minute bug coming back.
   *
   * The distinction is time, and only time. Two files are in the vault: one from
   * before this manager existed, one that appeared after the arm. The second is
   * the only candidate, so it is returned, and the first is left alone.
   *
   * `announced` stays true for the file that is returned, which is the
   * deliberate choice discussed in `collect`: it means "this action caused this
   * file", and the mtime filter above is what makes that claim safe. Asserting
   * it here so a later change to it has to be a decision rather than a slip.
   */
  const dir = await mkdtemp(join(tmpdir(), "fresh-arm-"));
  const vault = new DownloadVault(dir);
  await vault.ensure();
  const stale = join(dir, "old.txt");
  await writeFile(stale, "old bytes");
  const then = (Date.now() - 60_000) / 1000;
  await utimes(stale, then, then);

  const ledger = new RunLedger();
  const manager = new ArtifactManager(vault, ledger);

  let reject: ((error: Error) => void) | undefined;
  const page = {
    waitForEvent: () =>
      new Promise<never>((_resolve, rejectWait) => {
        reject = rejectWait;
      }),
  };
  const token = await manager.arm(page as never);
  /*
   * The browser wrote the file and told nobody, which is the race. The wait is
   * long on purpose: the comparison is in milliseconds but the filesystem's
   * mtime granularity is not guaranteed to be, and a test that depends on it
   * would fail on a machine with one-second timestamps rather than here.
   */
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const fresh = join(dir, "guid-named-file");
  await writeFile(fresh, "invoice bytes");
  reject?.(new Error("no event"));

  const artifact = await manager.collect(token, { actionId: "a9" });

  assert.equal(artifact?.path, fresh, "the file that appeared after the arm is the one the action produced");
  assert.equal(artifact?.announced, true, "a file this arm alone can have caused is attributed to the action");
  const recorded = ledger.downloadsFromActions();
  assert.equal(recorded.length, 1, "the download is recorded once, for the file the trigger produced");
  assert.equal(recorded[0]!.name, "guid-named-file", "and the stale file is not it");
  assert.equal(recorded[0]!.triggeredBy, "a9");
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
