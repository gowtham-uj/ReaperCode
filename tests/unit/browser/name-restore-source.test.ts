/**
 * The two name maps agree, and the registry is the one that leads.
 *
 * A live mission showed `p5 "ui-testing"` in the `TABS` listing while
 * `await p.pageName` on that same page returned `undefined`, and the agent spent
 * two thinking blocks working out which of its own tabs it was looking at. The
 * two maps had diverged:
 *
 *   - the registry is handed names as pages are created, and transfers an id by
 *     name across a reconnect, so it survived;
 *   - the runtime's `named` map is rebuilt from a state file by matching URLs
 *     exactly, which fails for any page not at the URL it was saved at, and a
 *     page is mid-navigation on every reconnect.
 *
 * So the registry is consulted first and the map is filled from it. This checks
 * the ordering in the source, because the failure is an ordering failure: with
 * the lookup after the URL match, a page whose URL moved never gets its name
 * back, and the test that would catch it needs a reconnect to reproduce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../src/browser/thread-runtime.ts", import.meta.url), "utf8");

test("restoreNames consults the registry before matching on URL", () => {
  const start = source.indexOf("private async restoreNames");
  assert.ok(start !== -1, "restoreNames must exist");
  const end = source.indexOf("\n  private ", start + 10);
  const body = source.slice(start, end === -1 ? start + 3000 : end);

  const registryAt = body.indexOf("this.kit.registry.find(entry.name)");
  const urlMatchAt = body.indexOf("page.url() === entry.url");
  assert.ok(registryAt !== -1, "the registry must be consulted, or a page that moved keeps no name");
  assert.ok(urlMatchAt !== -1, "the URL match must remain as the fallback");
  assert.ok(
    registryAt < urlMatchAt,
    "the registry lookup must come first: the URL match is the one that fails on a reconnect",
  );
});

test("the registry name is written into the runtime map, not just read", () => {
  /*
   * Reading it is not enough. The runtime's own map is what `setActive`,
   * `pageName` and the page listing all go through, so a name the registry knows
   * and the map does not is still a name the model cannot use.
   */
  const start = source.indexOf("private async restoreNames");
  const body = source.slice(start, start + 3000);
  assert.match(
    body,
    /this\.named\.set\(entry\.name, \{ name: entry\.name, page: registered\.page/,
    "a name the registry holds must be written into the map that the rest of the runtime reads",
  );
});
