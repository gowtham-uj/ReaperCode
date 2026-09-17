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

import { DownloadVault } from "../../../src/browser/downloads.js";

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
