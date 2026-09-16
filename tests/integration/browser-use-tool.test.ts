/**
 * `browser_use` as the model actually calls it.
 *
 * This is the tool's contract, tested from the outside: a program goes in, a
 * receipt comes out. Everything below the tool is already covered elsewhere
 * (`browser-slice.test.ts` drives the runtime, the unit suites drive the
 * compiler), so what is asserted here is only what the tool itself promises:
 *
 *   - a program runs against the page that is already open
 *   - the outcome is the *real* one, not whether the call threw
 *   - a syntax error says so rather than reporting a page that did not change
 *   - the program's own return value comes back, serialized
 *
 * The design questions this file exists to answer are the ones a receipt can get
 * wrong: telling the model SUCCESS when nothing happened, and telling it nothing
 * happened when it did.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { startTortureSite, type RunningTortureSite } from "../fixtures/torture-site.js";
import { probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? "http://127.0.0.1:9222";
const availability = await probeBrowser(CDP_URL);
const skip = skipUnless(availability);
const site: RunningTortureSite | undefined = availability.available ? await startTortureSite() : undefined;

let shared: ThreadBrowserRuntime | undefined;
async function runtime(): Promise<ThreadBrowserRuntime> {
  if (!shared) {
    shared = new ThreadBrowserRuntime({ threadId: "tool", cdpUrl: CDP_URL });
    await shared.ensureReady();
  }
  return shared;
}

const metadata = { runId: "test", artifactDir: "/tmp", toolCallId: "call-1" };

/** Run a program the way the tool does, after opening a fixture page. */
async function use(path: string, code: string, extra: { expected_revision?: number } = {}) {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}${path}`, { waitUntil: "domcontentloaded" });
  await rt.view();
  return executeBrowserUse(rt, { code, ...extra }, metadata);
}

test("a program runs against the page that is already open", { skip }, async () => {
  const result = await use("/basic", `await page.getByRole("button", { name: "Continue" }).click();`);
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /OUTCOME: SUCCESS/);
  assert.match(result.output, /submitted/, "the change the click caused must be reported");
});

test("a program that changes nothing reports NO_CHANGE, not success", { skip }, async () => {
  /*
   * The failure this tool exists to prevent. Playwright resolves a click that
   * changed nothing, so a tool that reported "did the call throw" would say
   * success and the model would click Continue six times and declare the task
   * done.
   */
  const result = await use("/canvas", `await page.locator("#c").click({ position: { x: 5, y: 5 } });`);
  assert.equal(result.outcome, "NO_CHANGE", result.output);
  assert.match(result.output, /did not change/);
});

test("a syntax error says so and does not pretend the page was read", { skip }, async () => {
  /*
   * The transaction never ran, so there is no page state to report. Saying
   * "the page did not change" would be true and useless; the model needs to know
   * its program did not run.
   */
  const result = await use("/basic", `await page.getByRole(("button".click();`);
  assert.equal(result.outcome, "PRECONDITION_FAILED", result.output);
  assert.match(result.output, /did not compile/);
  assert.equal(result.isError, true);
});

test("the program's return value comes back", { skip }, async () => {
  // How a model reads data: the last expression is the answer.
  const result = await use("/basic", `page.title()`);
  assert.match(result.output, /RETURNED:/);
  assert.match(result.output, /Basic form/);
  assert.equal(result.outcome, "SUCCESS", result.output);
});

test("a returned page or element is described, not dumped", { skip }, async () => {
  /*
   * The context bomb the serializer exists for. A model that returns `page`
   * by accident must not get a page of Playwright internals back.
   */
  const result = await use("/basic", `page`);
  assert.ok(result.output.length < 4_000, `a returned Page must not flood the context: ${result.output.length}`);
  assert.doesNotMatch(result.output, /_connection|_channel/, "internals must not leak");
});

test("an action that throws still reports the page it left behind", { skip }, async () => {
  /*
   * The most useful thing after a failed click is the page, and it is exactly
   * what a thrown error discards. A click that timed out because a dialog is over
   * the button has told the model something real.
   */
  const result = await use("/basic", `await page.getByRole("button", { name: "Nonexistent" }).click({ timeout: 500 });`);
  assert.notEqual(result.outcome, "SUCCESS", result.output);
  assert.equal(result.isError, true);
  // The receipt still carries the page, which is the part worth having.
  assert.match(result.output, /OUTCOME:/);
});

test("acting on a stale revision is refused before anything runs", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();
  const stale = rt.observer.revision;
  await rt.view();

  const result = await executeBrowserUse(rt, { code: `await page.getByRole("button", { name: "Continue" }).click();`, expected_revision: stale }, metadata);
  assert.equal(result.outcome, "STALE_REVISION", result.output);
  assert.match(result.output, /revision/);
});

test("a multi-step program is one decision, which is the point of the tool", { skip }, async () => {
  /*
   * The property that makes a program better than a verb: filling the form and
   * submitting it is one call and one receipt, not five round trips each with a
   * fresh snapshot.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        await page.locator("#first").fill("Ada");
        await page.locator("#last").fill("Lovelace");
        await page.locator("#country").selectOption("DE");
        await page.locator("#remote").check();
        await page.getByRole("button", { name: "Continue" }).click();
        page.locator("#first").inputValue()
      `,
    },
    metadata,
  );

  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /Ada/, "the value the program returned");
  assert.match(result.output, /submitted/, "and the change it caused");
});

test.after(async () => {
  await shared?.close();
  shared = undefined;
  await site?.close();
});

/* ------------------------------------------------------------------ *
 * The paths the probes found broken
 *
 * Each of these was a real defect found by running the tool rather than reading
 * it, and each is here so it cannot come back silently. They are grouped because
 * they share a cause: the tool's edge cases are where a model gets a wrong
 * answer that looks like a right one.
 * ------------------------------------------------------------------ */

test("a program with statements returns its last expression", { skip }, async () => {
  /*
   * The bug: the first compiler looked for the words `return`, `await` or
   * `async` to decide whether a program was a statement body or an expression.
   * A statement body has none of them, so it was wrapped as an expression, which
   * either failed to compile or silently returned undefined.
   */
  const result = await use("/basic", `const t = await page.title(); t`, { observe: "none" } as never);
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /Basic form/, "the last expression must come back");
});

test("a declaration with no trailing expression still returns its binding", { skip }, async () => {
  // `const rows = await page.locator(…)` is what a model writes when it means
  // to return the binding and forgot to name it.
  const result = await use("/basic", `const t = await page.title();`, { observe: "none" } as never);
  assert.match(result.output, /Basic form/, "a trailing declaration must be lifted, not dropped");
});

test("a runaway program is cut off rather than hanging the turn", { skip }, async () => {
  /*
   * All browser code awaits, and every await yields, so a host timer catches
   * this. A synchronous spin cannot be caught and is documented as accepted.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const started = Date.now();
  const result = await executeBrowserUse(rt, { code: `while (true) { await page.title(); }`, timeout_ms: 2_000 } as never, metadata);
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, "TIMEOUT", result.output);
  assert.ok(elapsed < 10_000, `the deadline must fire near 2s, took ${elapsed}ms`);
  assert.match(result.output, /cut off/);
});

test("a page the model closes is replaced, and the next step continues", { skip }, async () => {
  /*
   * Steel's own model treats a closed page as ordinary: a session has one
   * primary page, `refreshPrimaryPage()` closes it and assigns another, and every
   * target-destroyed path exists to be handled. So closing one is not a failure,
   * and reporting BROWSER_DISCONNECTED sent the model hunting a fault that did
   * not exist while the fix was one word: continue.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const closed = await executeBrowserUse(rt, { code: `await page.close(); "done"`, observe: "none" } as never, metadata);
  assert.equal(closed.outcome, "SUCCESS", closed.output);
  assert.match(closed.output, /new page is open/, "the model must be told it can continue");

  // And the next call genuinely works, without the model doing anything special.
  const next = await executeBrowserUse(
    rt,
    { code: `await page.goto("${site!.origin}/basic"); await page.getByRole("button", { name: "Continue" }).click()`, observe: "none" } as never,
    metadata,
  );
  assert.equal(next.outcome, "SUCCESS", next.output);
});

test("a program can open a tab and switch to it", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    { code: `const p = await browser.newPage("cart"); await p.goto("${site!.origin}/hidden"); p.url()`, observe: "none" } as never,
    metadata,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /\/hidden/, "the new tab's url comes back");
});

test("moving to another tab says so instead of faking a diff", { skip }, async () => {
  /*
   * Two different pages have nothing in common, so diffing one against the
   * other produced a large spurious Removed/Added list that the model would read
   * as "the whole page changed". The receipt has to name the tab change as the
   * fact it is.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    { code: `const p = await browser.newPage("cart"); await p.goto("${site!.origin}/hidden"); "moved"`, observe: "none" } as never,
    metadata,
  );
  assert.match(result.output, /different tab/, "the tab change must be named");
  assert.doesNotMatch(result.output, /^Removed:/m, "and must not be dressed up as a diff of one page");
});

test("two threads cannot see each other's pages", { skip }, async () => {
  /*
   * The isolation the whole per-thread design rests on, asserted rather than
   * assumed: a page opened in one thread's context must not appear in another's.
   */
  const other = new ThreadBrowserRuntime({ threadId: "other-thread", cdpUrl: CDP_URL });
  try {
    const mine = await runtime();
    const { page } = await mine.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

    const theirs = (await other.ensureReady()).page;
    const listed = await executeBrowserUse(
      other,
      { code: `browser.pages()`, observe: "none" } as never,
      metadata,
    );
    assert.doesNotMatch(listed.output, /\/basic/, "the other thread must not see this thread's page");
    assert.equal(theirs.url(), "about:blank", "and it starts on its own blank page");
  } finally {
    await other.close();
  }
});
