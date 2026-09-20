/**
 * A context a program makes is closed when the thread is released.
 *
 * `browser.newContext()` is allowed in the sandbox and always was: a program
 * that wants an isolated context has a legitimate reason, and the scoping
 * handles the isolation. What was missing is that nothing ever closed one. The
 * runtime closes its own context on release, and a context a *program* made was
 * not the runtime's, so no one took responsibility for it: it held its cookies,
 * its storage and its renderer for the life of the browser.
 *
 * Checked in the source rather than against a live browser, because the failure
 * needs a release to observe and the shape is what went wrong: the creation has
 * to report, and the release has to close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [scoped, runtime] = await Promise.all([
  readFile(new URL("../../../src/browser/scoped-page.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../src/browser/thread-runtime.ts", import.meta.url), "utf8"),
]);

test("creating a context reports it to the runtime", () => {
  /*
   * The scoping module cannot close it, because it does not know when the thread
   * is finished. It can say that one was made, and that is the whole contract.
   */
  assert.match(scoped, /onContextCreated\?\.\(created\)/, "the creation must be reported, or nothing can close it");
  assert.match(
    scoped,
    /newContext\(options\)\.then\(\(created\) => \{/,
    "and reported from the one place a context is actually made",
  );
});

test("the report carries the real context, not the scoped proxy", () => {
  /*
   * Closing through the proxy would go through a guard written for programs. The
   * runtime is the thing that owns the thread, so it gets the object itself.
   */
  const at = scoped.indexOf("onContextCreated?.(created)");
  const proxyAt = scoped.indexOf("scopeContext(created, threadId, onContextCreated)", at);
  assert.ok(at !== -1 && proxyAt !== -1 && at < proxyAt, "the real object is reported before the proxy is built");
});

test("releasing the thread closes every context a program made", () => {
  const at = runtime.indexOf("private async release");
  assert.ok(at !== -1, "release must exist");
  const body = runtime.slice(at, at + 6000);
  assert.match(body, /for \(const created of this\.programContexts\)/, "every tracked context must be closed");
  assert.match(body, /this\.programContexts\.clear\(\)/, "and the set must not survive the release");
  /*
   * Best effort per context: one that refuses must not stop the others, and must
   * not stop the detach. A stuck context is smaller than a stuck release.
   */
  assert.match(body, /created\.close\(\)\.catch\(\(\) => undefined\)/, "a context that will not close must not block the rest");
});

test("the set is bounded by the contexts that actually exist", () => {
  /*
   * Nothing prunes it mid-life, and that is correct rather than an oversight: a
   * context a program made is one it may still be using, and closing it early
   * would break the program that holds it. The bound is that a release clears
   * the set, so the next run of the same thread starts empty.
   */
  assert.match(runtime, /private readonly programContexts = new Set<BrowserContext>\(\)/);
});
