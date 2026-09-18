/**
 * The browser surface a program gets, against the one it is promised.
 *
 * Written after a documented control turned out to be unbound, twice.
 *
 * `BROWSER_PROGRAM_PARAMS` is the list of names a browser program may use, and
 * the tool description tells the model to call several of them. The sandbox
 * surface is built in one file and bound into the worker in another, and the
 * worker kept its own copy of the names. `recover`, `probeInput` and
 * `capabilities` were in the documented list and in neither of the worker's
 * lists, so the host bound nothing under those names: a model that called
 * `capabilities()` exactly as instructed got "capabilities is not defined".
 *
 * The failure is worth a test rather than a comment because of how it presents.
 * `page` and `browser` are membrane proxies that answer every property with a
 * callable, so the model's own existence check (`typeof browser.capabilities`)
 * returned "function" while calling it failed. A model cannot diagnose this from
 * inside the sandbox, and the previous fix for the identical bug on `recover`
 * added the name to the documented list without adding it to the surface, which
 * is how it recurred.
 *
 * So this compares the two directly, and it is the only check that would have
 * caught either instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BROWSER_PROGRAM_PARAMS } from "../../../src/browser/remote-page-source.js";

/**
 * The keys the sandbox surface is documented to expose.
 *
 * Read from the same module the sandbox is built from, so this cannot agree with
 * a stale copy. `buildRemoteBrowser` is not exported (it is emitted as source),
 * so the contract is asserted at the two seams that are observable: the emitted
 * source must define a function for every documented name, and the returned
 * object literal must list each one.
 */
test("every documented browser control is defined and returned by the sandbox", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../../src/browser/remote-page-source.ts", import.meta.url), "utf8"),
  );

  /*
   * The returned object literal, which is what a program actually receives.
   * Parsed out of the emitted source rather than imported, because the sandbox
   * file exports source text rather than values: it is injected into a worker.
   */
  const returnAt = source.lastIndexOf("  return {");
  assert.ok(returnAt !== -1, "the sandbox must return a surface object");
  const body = source.slice(returnAt, source.indexOf("  };", returnAt));
  const returned = new Set(
    body
      .split("\n")
      .map((line) => line.trim().replace(/,$/, ""))
      .filter((line) => line.length > 0)
      .map((line) => line.split(":")[0]!.trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
  );

  for (const name of BROWSER_PROGRAM_PARAMS) {
    assert.ok(
      returned.has(name),
      `the sandbox must expose "${name}": it is documented in BROWSER_PROGRAM_PARAMS, so a program can call it`,
    );
  }
});

test("every documented control has a definition in the sandbox source", async () => {
  /*
   * The other half. A name in the returned object that is not defined above it
   * is a `ReferenceError` at surface-construction time, which would break every
   * browser program rather than one call.
   */
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../../src/browser/remote-page-source.ts", import.meta.url), "utf8"),
  );
  for (const name of BROWSER_PROGRAM_PARAMS) {
    const asFunction = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
    // `page`, `browser` and `pages` are built by `makeNode`, not declared as
    // functions, so they are checked by being present in the return map only.
    if (name === "page" || name === "browser" || name === "pages") continue;
    const declared =
      asFunction.test(source) ||
      new RegExp(`const\\s+${name}\\s*=`).test(source) ||
      new RegExp(`${name}\\s*:\\s*\\(`).test(source);
    assert.ok(declared, `"${name}" is documented but has no definition in the sandbox source`);
  }
});

test("the host answers every helper the sandbox can send", async () => {
  /*
   * The third place the same three names were missing.
   *
   * A helper reaches the host as a `{ method }` frame and is dispatched by a
   * switch in `observeCall`. A name the sandbox sends and the switch does not
   * answer falls to `default`, which reports it as a bug in the injected source.
   * That is the right error for a genuinely unknown name and the wrong outcome
   * for a documented one, and `recover`, `probeInput` and `capabilities` hit it
   * after passing the first two checks because nobody had compared the three
   * lists.
   *
   * So all three are compared: the documented params, the sandbox's returned
   * object, and this switch.
   */
  const [sandbox, host] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../../src/browser/remote-page-source.ts", import.meta.url), "utf8"),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../../src/browser/browser-program.ts", import.meta.url), "utf8"),
    ),
  ]);

  // Every helper the sandbox sends by name, from its `callHelper('x', …)` calls.
  const sent = new Set(
    [...sandbox.matchAll(/callHelper\('([A-Za-z_$][\w$]*)'/g)].map((match) => match[1]!),
  );
  assert.ok(sent.size > 0, "the sandbox must send helpers by name");

  const handled = new Set(
    [...host.matchAll(/case "([A-Za-z_$][\w$]*)":/g)].map((match) => match[1]!),
  );

  for (const name of sent) {
    /*
     * `view`, `viewChanges` and `screenshot` are dispatched too, but they take a
     * different path through the same switch; the point here is the named
     * control helpers, which is where the omissions were.
     */
    assert.ok(
      handled.has(name),
      `the host must handle "${name}": the sandbox can send it, so an unhandled method is a dead control`,
    );
  }
});

test("the worker binds the surface by reading it, not from a second list", async () => {
  /*
   * The mechanism of the bug. The worker had its own name array beside its own
   * value array, and a name missing from the array is a name the program does
   * not have, however correct the surface is.
   *
   * Asserted on the source because the worker runs in a separate thread and its
   * wiring cannot be imported. The property that matters is structural: the
   * names come from the surface object, so no list exists to drift.
   */
  const worker = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../../../src/tools/code/worker-source.ts", import.meta.url), "utf8"),
  );
  assert.match(
    worker,
    /Object\.entries\(surface\)/,
    "the worker must derive the bound names from the surface, or the two lists can drift again",
  );
  assert.doesNotMatch(
    worker,
    /extraNames\.push\(\s*\n?\s*'page'/,
    "a hand-written name list in the worker is the bug this test exists for",
  );
});
