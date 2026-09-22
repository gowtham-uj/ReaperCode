/**
 * The download vault's naming rules.
 *
 * A vault exists because a downloaded file has to outlive the page and the
 * connection that produced it. The rules worth testing without a browser are the
 * ones about names: two files called `invoice.pdf` are two different files, and
 * a suggested name is attacker-adjacent input from the site being visited.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectUnannounced, DownloadVault } from "../../../src/browser/downloads.js";

const vaultAt = async (): Promise<DownloadVault> => new DownloadVault(await mkdtemp(join(tmpdir(), "vault-")));

/** A session marker that just began, for the tests where the file is this run's. */
const startedJustNow = (): number => Date.now() - 1000;

/**
 * Push a file's mtime into the past, so it stands in for one an earlier run left.
 *
 * `utimes` sets access and modification time on the file itself. `copyFile` does
 * not carry timestamps over, which is why the vault's copy lands with the mtime
 * of the copy rather than the download, and why a test can place a file in a
 * session other than this one.
 */
const backdate = async (path: string, byMs: number): Promise<void> => {
  const when = (Date.now() - byMs) / 1000;
  await utimes(path, when, when);
};

test("a path is resolved inside the vault and nowhere else", async () => {
  const vault = await vaultAt();
  const resolved = vault.resolve("invoice.pdf");
  assert.ok(resolved.endsWith("invoice.pdf"));
  // A name that tries to climb is reduced to its basename.
  const climbed = vault.resolve("../../etc/passwd");
  assert.ok(climbed.endsWith("passwd"), climbed);
  assert.ok(!climbed.includes(".."), climbed);
});

test("the vault lists what is in it, with sizes", async () => {
  const vault = await vaultAt();
  const dir = await vault.ensure();
  await writeFile(join(dir, "a.pdf"), "hello");
  await writeFile(join(dir, "b.txt"), "hi");
  const files = await vault.list();
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ["a.pdf", "b.txt"]);
  assert.equal(files.find((f) => f.name === "a.pdf")?.bytes, 5);
});

test("an empty vault lists nothing rather than failing", async () => {
  const vault = await vaultAt();
  assert.deepEqual(await vault.list(), []);
});

test("two files with the same name do not overwrite each other", async () => {
  /*
   * The rule that matters: keeping one of two `invoice.pdf` is a loss discovered
   * at the worst possible moment. The second gets a suffix instead.
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  await writeFile(join(dir, "invoice.pdf"), "first");
  // `uniqueName` is private; exercised through a fake download.
  const fake = {
    suggestedFilename: () => "invoice.pdf",
    saveAs: async (target: string) => { await writeFile(target, `copy-${Date.now()}`); },
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };
  const saved = await vault.accept(fake as never);
  assert.notEqual(saved.name, "invoice.pdf", "must not reuse a taken name");
  const names = await readdir(dir);
  assert.equal(names.length, 2, `both files must exist, got ${names.join(",")}`);
});

test("two listeners on one download produce one file, not an ENOENT", async () => {
  /*
   * The flake this pins, and it was measured rather than imagined.
   *
   * Two things watch for downloads on a page: the `page.on("download")` handler
   * that keeps anything a program's click produced, and the armed
   * `waitForEvent("download")` that `download()` uses. Both fire for the same
   * event and both used to call `saveAs`, so whichever lost the race found the
   * browser's temporary file already consumed:
   *
   *   download.saveAs: ENOENT: no such file or directory, copyfile
   *
   * It presented as a flake (the same integration test passed twice and failed
   * once in three runs), because which of the two got there first depends on
   * timing. A test cannot pin a race by running it, so what is asserted here is
   * the property that removes it: accepting the same Download twice copies it
   * once and answers the same file both times.
   */
  const vault = await vaultAt();
  let copies = 0;
  const fake = {
    suggestedFilename: () => "invoice.txt",
    saveAs: async (target: string) => {
      copies += 1;
      /*
       * The second call fails the way Playwright's does when the temporary file
       * is gone, so a regression is a failure here rather than a silent second
       * file with a numeric suffix.
       */
      if (copies > 1) throw new Error("ENOENT: copyfile failed");
      await writeFile(target, "invoice bytes");
    },
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };

  const [first, second] = await Promise.all([vault.accept(fake as never), vault.accept(fake as never)]);
  assert.equal(copies, 1, "the file must be copied exactly once");
  assert.equal(first.path, second.path, "and both callers must get the same file");
  assert.equal((await vault.list()).length, 1, "the vault holds one file, not two");
});

test("a file the browser wrote without announcing it is still found", async () => {
  /*
   * The twenty-minute bug, in one test.
   *
   * `page.on("download")` is Playwright's notification, and it depends on this
   * process owning the browser's download configuration. Steel sets its own at
   * launch, so a client re-setting it is racing the platform; when the race is
   * lost the file still lands on disk and nothing announces it.
   *
   * Measured on a live mission: the vault stayed empty, `downloadAfter` refused
   * with a message about the page, and the model spent twenty minutes proving the
   * page was fine. The page always was. So the directory is checked as well as
   * the event, and this pins that a file present but unannounced is collected.
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  await writeFile(join(dir, "guid-named-file"), "invoice bytes");

  const collected: Array<{ name: string; path: string; bytes: number }> = [];
  /* The file was written a moment ago, so it is inside this session. */
  const found = await collectUnannounced(vault as never, collected as never, startedJustNow());

  assert.equal(found.length, 1, "an unannounced file is found");
  assert.equal(found[0]!.name, "guid-named-file");
  assert.equal(found[0]!.bytes, 13);
  assert.equal(collected.length, 1, "and is added to the caller's collection");
});

test("a file from a previous run is not adopted as this session's download", async () => {
  /*
   * The receipt this bug made lie.
   *
   * The vault is per thread and on disk, so it outlives the runtime: after a
   * restart, everything the thread ever downloaded is unknown to `collected`.
   * The unbounded version adopted all of it, and `downloadAfter` then read the
   * last entry as the result of the click, so a page whose
   * `waitForEvent("download")` rejected still produced an artifact attributed to
   * the click.
   *
   * Measured shape, worth pinning exactly: a file with the bytes of a real
   * earlier download, present before this session started, and a read that
   * must report that nothing arrived.
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  const stale = join(dir, "invoice-from-yesterday.txt");
  await writeFile(stale, "invoice bytes");
  await backdate(stale, 60_000);

  const collected: Array<{ name: string; path: string; bytes: number }> = [];
  const found = await collectUnannounced(vault as never, collected as never, Date.now());

  assert.deepEqual(found, [], "a file older than this session is not this session's download");
  assert.equal(collected.length, 0, "and must not be added to the caller's collection");
});

test("collecting twice does not double-count a file", async () => {
  /*
   * `downloadAfter` calls this on every attempt, so a second call must be a
   * no-op for a file already known. Without this the same download would appear
   * once per retry and a caller reading the last entry would be reading the
   * right file by luck.
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  await writeFile(join(dir, "once.pdf"), "x");

  const collected: Array<{ name: string; path: string; bytes: number }> = [];
  const since = startedJustNow();
  await collectUnannounced(vault as never, collected as never, since);
  const second = await collectUnannounced(vault as never, collected as never, since);

  assert.equal(second.length, 0, "the second pass finds nothing new");
  assert.equal(collected.length, 1, "and the collection still holds one entry");
});

test("an empty file is not collected as a download", async () => {
  /*
   * A zero-byte file is a download that started and did not finish, or a
   * placeholder a site wrote. Handing it to an upload would fail later with a
   * message about the file, so it is not collected at all.
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  await writeFile(join(dir, "empty.pdf"), "");

  const collected: Array<{ name: string; path: string; bytes: number }> = [];
  const found = await collectUnannounced(vault as never, collected as never, startedJustNow());
  assert.equal(found.length, 0, "a zero-byte file is not a finished download");
});

test("a download lands where the sandbox can reach it", async () => {
  /*
   * The requirement, as a test: the vault must be inside the thread's own
   * workspace, because that directory is the sandbox's root bind.
   *
   * The bug this pins. The vault lived beside the browser state under
   * `.reaper/browser/<id>/downloads`, which the runtime could write and the
   * sandbox could not see. So a downloaded file was copied somewhere the agent
   * had no way to read, and a cross-site upload was impossible even when the
   * download itself succeeded. Measured alongside it: Playwright wrote to
   * `/tmp/playwright-artifacts-<random>/`, outside the sandbox bind, so
   * `download.saveAs` failed with ENOENT and the error was swallowed.
   *
   * The runtime derives the vault path from `workspaceRoot`, so the assertion is
   * that the derived path is a child of it. A path that merely exists would pass
   * a weaker check and still be unreachable.
   */
  const workspace = await mkdtemp(join(tmpdir(), "ws-"));
  const vault = new DownloadVault(join(workspace, ".reaper", "downloads"));
  const dir = await vault.ensure();

  assert.ok(
    dir.startsWith(workspace),
    `the vault must be inside the workspace so the sandbox mounts it: vault=${dir} workspace=${workspace}`,
  );
  assert.equal(vault.path, dir, "the path is reported, so the model can be told where a file landed");

  // And it is really usable: a file written there is visible through the vault.
  await writeFile(join(dir, "invoice.txt"), "downloaded");
  const files = await vault.list();
  assert.deepEqual(files.map((f) => f.name), ["invoice.txt"]);
});

test("a download whose artifact is gone is still stored, by streaming its bytes", async () => {
  /*
   * The failure that made this test exist, measured on a real run rather than
   * imagined:
   *
   *   the browser downloaded "invoice.txt" but it could not be copied into this
   *   thread's vault. download.saveAs: ENOENT: no such file or directory,
   *   copyfile '/tmp/playwright-artifacts-5djaMp/a0ea05ee-...' -> '.../invoice.txt'
   *
   * All three `copyFile` retries from `download.path()` failed with the same
   * ENOENT, because `path()` and `saveAs` name the same file and the browser had
   * removed it between the event and the copy. The bytes were available the whole
   * time over the CDP connection, which `createReadStream()` is the route to.
   *
   * The window this happens in is real: the download event fires when the
   * download *starts*, so a page that navigates or closes right after the click
   * can take the artifact with it, and the run that caught this had exactly that
   * shape.
   */
  const vault = await vaultAt();
  const { Readable } = await import("node:stream");
  let streamed = 0;
  const fake = {
    suggestedFilename: () => "invoice.txt",
    saveAs: async () => { throw new Error("ENOENT: no such file or directory, copyfile"); },
    path: async () => "/tmp/playwright-artifacts-gone/a0ea05ee",
    createReadStream: async () => {
      streamed += 1;
      return Readable.from([Buffer.from("invoice 4711: 66 bytes\n")]);
    },
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };

  const saved = await vault.accept(fake as never);
  assert.equal(streamed, 1, "the bytes are streamed when the artifact path is gone");
  assert.equal(saved.bytes, 23, "and the file lands with its real size");
  const files = await vault.list();
  assert.deepEqual(files.map((f) => f.name), ["invoice.txt"], "the vault holds the file");
});

test("a stream that fails leaves no partial file behind", async () => {
  /*
   * The other half of streaming: a stream can fail part-way, and a half-written
   * file is worse than none, because the next step would upload it and the
   * failure would look like the site rejecting a file that was never whole.
   */
  const vault = await vaultAt();
  const { Readable } = await import("node:stream");
  const fake = {
    suggestedFilename: () => "invoice.txt",
    saveAs: async () => { throw new Error("ENOENT: no such file or directory, copyfile"); },
    path: async () => undefined,
    createReadStream: async () => {
      async function* failing() {
        yield Buffer.from("partial");
        throw new Error("the connection dropped mid-stream");
      }
      return Readable.from(failing());
    },
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };

  await assert.rejects(() => vault.accept(fake as never), /could not be copied/);
  const names = await readdir(await vault.ensure());
  assert.deepEqual(names, [], `a failed copy must not leave a file, got ${names.join(",")}`);
});

test("a stream that delivers no bytes is a failed copy, not an empty file", async () => {
  /*
   * The regression this pins shipped, and it was found in a mission rather than
   * by a test: two runs downloaded the same invoice three times each and the
   * vault held three 0-byte files, every one of them reported as a successful
   * download. The model then spent tool calls on `ls` and `wc -c` trying to work
   * out why the site was serving nothing. The site was serving 66 bytes.
   *
   * The fallback is reached when the browser's temporary artifact has been
   * cleaned, and against the real endpoint it behaves like this:
   *
   *   saveAs:            REJECTED  download.saveAs: ENOENT: no such file ...
   *   createReadStream:  RESOLVED  streamed=0 bytes
   *
   * So the stream resolves and delivers nothing, and `pipeline` reports success.
   * Trusting that turned a loud failure into a silent one. A zero-byte result from
   * a copy that is already recovering from a failed `saveAs` is evidence the
   * source is gone, so it must fail here and let the caller report it.
   */
  const vault = await vaultAt();
  const { Readable } = await import("node:stream");
  const fake = {
    suggestedFilename: () => "invoice.txt",
    saveAs: async () => { throw new Error("ENOENT: no such file or directory, copyfile"); },
    path: async () => undefined,
    createReadStream: async () => Readable.from([]),
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };

  await assert.rejects(
    () => vault.accept(fake as never),
    /could not be copied/,
    "an empty stream must not be stored as a successful download",
  );
  const names = await readdir(await vault.ensure());
  assert.deepEqual(names, [], `no file may be left behind, got ${names.join(",")}`);
});

test("a real stream of the right size still succeeds", async () => {
  /*
   * The other side of the same check, so requiring bytes cannot regress the case
   * the fallback was added for. A stream that carries the file is stored.
   */
  const vault = await vaultAt();
  const { Readable } = await import("node:stream");
  const fake = {
    suggestedFilename: () => "invoice.txt",
    saveAs: async () => { throw new Error("ENOENT: no such file or directory, copyfile"); },
    path: async () => undefined,
    createReadStream: async () => Readable.from([Buffer.from("Hi Playwright Agent, Your total purchase amount is 2400. Thank you")]),
    failure: async () => null,
    url: () => "https://example.com/invoice",
  };

  const saved = await vault.accept(fake as never);
  assert.equal(saved.bytes, 66, "the bytes the browser had must be stored");
  assert.deepEqual((await vault.list()).map((f) => f.name), ["invoice.txt"]);
});

test("a runtime rebuilt over a full vault does not adopt the earlier history", async () => {
  /*
   * The reap case, which the process-start floor did not cover.
   *
   * The vault is per thread and on disk and outlives the runtime object;
   * `downloadedFiles` is per runtime and starts empty. The idle reaper drops a
   * runtime after ten minutes and the next use builds a new one, so a fresh
   * runtime over a vault still holding this thread's earlier downloads is the
   * normal case rather than an exotic one. A floor of process start does not
   * bound that: the file was written by this process, minutes ago, by a runtime
   * that no longer exists.
   *
   * The floor the tool passes is `max(processStart, runtime.startedAt)`, so this
   * pins the second half: a file that is newer than module load but older than
   * the runtime must not be adopted. The file here is written now (newer than
   * any process-start reading) and the current runtime is a `Date.now()` taken
   * after it, which is the shape of "the file was there when this runtime
   * started".
   */
  const vault = await vaultAt();
  const dir = await vault.ensure();
  const earlier = join(dir, "invoice-from-turn-1.txt");
  await writeFile(earlier, "earlier bytes");

  /* The runtime was built after that file landed, which is the reap. */
  const runtimeStartedAt = Date.now() + 5;
  const collected: Array<{ name: string; path: string; bytes: number }> = [];
  const found = await collectUnannounced(vault as never, collected as never, runtimeStartedAt);

  assert.deepEqual(found, [], "a file from before this runtime started is not this runtime's download");
  assert.equal(collected.length, 0);
});
