/**
 * Every option the browser owner reads must actually be wired by the server.
 *
 * Written after a feature was built, tested, and dead: the download vault was
 * moved into the thread's workspace, the runtime grew a `workspaceRoot` option,
 * a manager grew a `workspaceFor` method, and nothing connected them. The option
 * stayed `undefined`, the vault fell back to a path outside the sandbox, and a
 * live mission could not copy an invoice into a directory the model could read.
 *
 * The failure was invisible because the fallback is a legitimate path. Downloads
 * were "enabled", the vault directory existed, the event fired, and only the file
 * was somewhere the agent could never reach. Nothing errored; the model worked
 * around it with a fetch.
 *
 * This is the third time in this codebase that the same shape has cost a run:
 * a value produced in one file, consumed in another, and connected by nothing.
 * The browser surface had it (`capabilities` documented, listed, and unbound),
 * the eval surface had it (`formatSkillsForPrompt` computed and never read), and
 * now this. So the check is structural rather than behavioural: an option that
 * `buildRuntime` or `sweepOrphans` reads is an option `server.ts` must supply.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (relative: string): Promise<string> =>
  readFile(new URL(`../../../src/app-server/${relative}`, import.meta.url), "utf8");

test("every ThreadBrowsers option the class reads is supplied by the server", async () => {
  const [browsers, server] = await Promise.all([read("thread-browsers.ts"), read("server.ts")]);

  /*
   * The options the class actually reaches for, found by its own `this.options.x`
   * reads rather than from the interface. Reading the interface would pass on an
   * option nobody uses, and reading the class is what finds the ones that matter.
   */
  const used = new Set(
    [...browsers.matchAll(/this\.options\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!),
  );
  assert.ok(used.size > 0, "the class must read some options");

  /*
   * The object literal `new ThreadBrowsers({ ... })` in server.ts, with its
   * comments stripped.
   *
   * Stripping matters and was measured: with the comments left in, removing the
   * `workspaceFor` line still passed, because the explanatory comment above it
   * names the option. A check that a comment can satisfy is a check that will not
   * fire on the bug it was written for.
   */
  const at = server.indexOf("new ThreadBrowsers(");
  assert.ok(at !== -1, "the server must construct a ThreadBrowsers");
  const call = server
    .slice(at, server.indexOf("});", at))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  /*
   * Options that are deliberately the caller's to leave unset.
   *
   * An option with a default that is also the intended production value is not a
   * wiring bug when the server omits it: `?? 45_000` is the behaviour wanted, and
   * the setting exists so a test can shorten it. The distinction matters, because
   * a test that flagged these would be ignored, and one that ignores everything
   * would have missed the vault.
   *
   * Each entry names why it is exempt, so adding one is a decision rather than a
   * silencer.
   */
  const intentionalDefaults = new Map([
    ["sweepAttachTimeoutMs", "45_000 is the intended attach budget; the option exists so tests can shorten it"],
  ]);

  const unwired: string[] = [];
  for (const name of used) {
    if (intentionalDefaults.has(name)) continue;
    if (!new RegExp(`\\b${name}\\b`).test(call)) unwired.push(name);
  }

  assert.deepEqual(
    unwired,
    [],
    `these ThreadBrowsersOptions are read by the class but never passed by the server, so they are always undefined: ${unwired.join(", ")}`,
  );
});

test("the runtime is given a workspace, so its download vault is inside it", async () => {
  /*
   * The specific line, asserted directly because it is the one that was missing
   * and the one whose absence is silent. `buildRuntime` reads
   * `this.options.workspaceFor`, and the value has to reach the runtime as
   * `workspaceRoot` or the vault is derived from the state path instead.
   */
  const browsers = await read("thread-browsers.ts");
  assert.match(browsers, /const workspace = this\.options\.workspaceFor\?\.\(threadId\)/, "the runtime must ask for a workspace");
  assert.match(browsers, /workspaceRoot: workspace/, "and pass it to the runtime, or the vault is built outside the sandbox");
});
