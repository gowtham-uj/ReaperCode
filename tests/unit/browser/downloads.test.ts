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
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectUnannounced, DownloadVault } from "../../../src/browser/downloads.js";

const vaultAt = async (): Promise<DownloadVault> => new DownloadVault(await mkdtemp(join(tmpdir(), "vault-")));

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
  const found = await collectUnannounced(vault as never, collected as never);

  assert.equal(found.length, 1, "an unannounced file is found");
  assert.equal(found[0]!.name, "guid-named-file");
  assert.equal(found[0]!.bytes, 13);
  assert.equal(collected.length, 1, "and is added to the caller's collection");
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
  await collectUnannounced(vault as never, collected as never);
  const second = await collectUnannounced(vault as never, collected as never);

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
  const found = await collectUnannounced(vault as never, collected as never);
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
