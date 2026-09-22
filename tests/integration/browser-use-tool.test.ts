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
import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;
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

/**
 * The value a program returned, read out of the tool's output.
 *
 * The tool prints more after the returned value, and on purpose: the page and the
 * tab list follow it, because the answer comes first and the state of the page is
 * context for the next step. So the returned value is the text between `RETURNED:`
 * and the first blank line, which is where the tool's own sections begin.
 *
 * Reading to the end of the output was correct only while the tab list happened to
 * be suppressed, and that suppression was a bug: a model opening ten sites calls
 * `browser.pages()` in every program, so the condition that guarded it never fired
 * and the block printed on none of five programs. Removing the suppression is what
 * exposed these three parses, which had been green against a tab list nobody saw.
 */
function returnedValue(output: string): string {
  const marker = output.indexOf("RETURNED:");
  assert.ok(marker !== -1, `the output carries no returned value: ${output.slice(0, 300)}`);
  const after = output.slice(marker + "RETURNED:".length).trim();
  const blank = after.indexOf("\n\n");
  return (blank === -1 ? after : after.slice(0, blank)).trim();
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
  /*
   * Asserted on what the model is told rather than on the phrase that said it.
   *
   * This pinned `/new page is open/`, and commit 559d646b3 replaced that sentence
   * with a better one ("one was opened for you at about:blank; nothing else was
   * touched") without updating this assertion. The test has been red since, and
   * it was red for the right reason about the wrong thing: the behaviour never
   * broke, the wording moved. A check whose subject is a literal sentence is a
   * check that fails whenever somebody improves the sentence.
   *
   * What matters is the property the test's own comment names: the model is told
   * a usable page exists and that it may continue. Both halves are asserted.
   */
  assert.match(closed.output, /opened/i, "the model must be told a page is available");
  assert.match(closed.output, /about:blank|at http/i, "and where that page is, so the next step knows what it is driving");

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

test("scoping a look to a locator reads only that region", { skip }, async () => {
  /*
   * The bug this pins: `view(page.locator("form"))` passed a Locator, the
   * runtime only recognised a Page, and everything else fell through to the
   * active page. The call *succeeded* and returned the whole page, so a program
   * that scoped a look to save tokens paid for all of it and never learned why.
   *
   * Asserted on content rather than on length, because length is the symptom:
   * what must not appear is the navigation, which is outside the form.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const scoped = await executeBrowserUse(
    rt,
    { code: `return await view(page.locator("form"))`, observe: "none" } as never,
    metadata,
  );
  assert.equal(scoped.outcome, "SUCCESS", scoped.output);

  /*
   * The RETURNED section, not the whole output.
   *
   * The receipt also carries the page diff since the last look, which is the
   * whole page and correctly contains the navigation. What is being asserted is
   * that the program's *scoped read* returned the region, so the assertion is
   * anchored after RETURNED rather than to the output as a whole. Getting this
   * wrong is how the test failed first time while the behaviour was right.
   */
  const returned = scoped.output.slice(scoped.output.indexOf("RETURNED:"));
  assert.match(returned, /Continue/, "the form's own contents must be there");
  assert.doesNotMatch(returned, /\/react/, "and the navigation outside it must not");
});

test("the documented view({ selector }) form scopes the read too", { skip }, async () => {
  /*
   * The other half of the same bug, and the one the tool's own message offers.
   *
   * When a view is trimmed, the notice tells the model to use `view({ selector })`
   * for one region or `view({ depth })` for more levels. Both are advice the model
   * is meant to act on. The sandbox forwards a program's arguments verbatim, so
   * `view({ selector: "nav" })` arrived at the host as a plain object, the wrapper
   * turned it into `{ page: { selector: "nav" } }`, nothing recognised the "page",
   * and the read fell back to the whole page: a program following the tool's own
   * remedy paid for the full page and had no way to tell it had been ignored.
   *
   * Asserted on content, for the same reason as the locator test above: the
   * receipt carries the whole-page diff, so the assertion is anchored after
   * RETURNED rather than to the output as a whole.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const scoped = await executeBrowserUse(
    rt,
    { code: `return await view({ selector: "form" })`, observe: "none" } as never,
    metadata,
  );
  assert.equal(scoped.outcome, "SUCCESS", scoped.output);
  assert.match(scoped.output, /Scope: selector: form/, "the receipt must say what was scoped to");

  const returned = scoped.output.slice(scoped.output.indexOf("RETURNED:"));
  assert.match(returned, /Continue/, "the form's own contents must be there");
  assert.doesNotMatch(returned, /\/react/, "and the navigation outside it must not");
});

test("scoping by a role that does not exist fails loudly", { skip }, async () => {
  /*
   * A bare `<form>` has no ARIA `form` role, so `getByRole("form")` matches
   * nothing. The skill used to recommend exactly that, and the failure is worth
   * keeping loud: a scoped look that silently matches nothing would report an
   * empty region, which reads as "the form is gone" rather than "your locator is
   * wrong".
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const wrong = await executeBrowserUse(
    rt,
    { code: `return await view(page.getByRole("form"))`, observe: "none" } as never,
    metadata,
  );
  assert.notEqual(wrong.outcome, "SUCCESS", wrong.output);
  assert.match(wrong.output, /does not match any element/, "and it must say why");
});

/* ------------------------------------------------------------------ *
 * One thread cannot reach another's pages
 *
 * Confirmed as a working attack before it was fixed: every thread attaches to
 * the same Steel Chrome, `browser.contexts()` is browser-wide, and this line
 *
 *     page.context().browser().contexts().flatMap(c => c.pages())
 *
 * let one agent find and drive another agent's page. The scoped page closes it.
 * ------------------------------------------------------------------ */

test("a program cannot enumerate another thread's contexts", { skip }, async () => {
  const other = new ThreadBrowserRuntime({ threadId: "other-agent", cdpUrl: CDP_URL });
  try {
    const mine = await runtime();
    const { page } = await mine.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

    const theirs = (await other.ensureReady()).page;
    await theirs.goto(`${site!.origin}/hidden`, { waitUntil: "domcontentloaded" });

    const counted = await executeBrowserUse(
      mine,
      { code: `page.context().browser().contexts().length`, observe: "none" } as never,
      metadata,
    );
    const count = Number(returnedValue(counted.output));
    assert.equal(count, 1, `a program must see one context, its own, not every thread's: ${counted.output.slice(-300)}`);
  } finally {
    await other.close();
  }
});

test("a program cannot drive another thread's page", { skip }, async () => {
  /*
   * The attack, run for real. It found the other agent's page by URL and
   * navigated it, and the other thread's page ended up somewhere it had not
   * asked to be.
   */
  const other = new ThreadBrowserRuntime({ threadId: "victim-agent", cdpUrl: CDP_URL });
  try {
    const mine = await runtime();
    const { page } = await mine.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

    const victim = (await other.ensureReady()).page;
    await victim.goto(`${site!.origin}/hidden`, { waitUntil: "domcontentloaded" });
    const victimUrlBefore = victim.url();

    const attack = await executeBrowserUse(
      mine,
      {
        /*
         * Awaited, because a browser program runs against a proxy: a chain that
         * has not been awaited is a pending path rather than a value, so
         * `others.length` on an unawaited chain is a node and never `0`. That is
         * a real difference from writing Playwright in-process, it is documented
         * in the tool description, and it does not weaken the assertion: the
         * point is that the other thread's page cannot be found or driven, and
         * the awaited form is the strongest way to look for it.
         */
        code: `
          const others = await page.context().browser().contexts().flatMap(c => c.pages()).filter(p => p.url().includes("/hidden"));
          if (others.length === 0) return "blocked";
          await others[0].goto("${site!.origin}/canvas");
          return "drove it";
        `,
        observe: "none",
      } as never,
      metadata,
    );

    assert.match(attack.output, /blocked/, "the other thread's page must not be findable");
    assert.equal(victim.url(), victimUrlBefore, "and the other thread's page must be where it was");
  } finally {
    await other.close();
  }
});

/*
 * The accessors that hand back an object, closed.
 *
 * `page`, `context` and `contexts` were wrapped, but every other accessor
 * forwarded its result raw, so the boundary held for one hop and then stopped.
 * All three calls below returned the real `_Page` from a sandboxed program and
 * the full chain was every thread's pages again. None of them is an adversarial
 * construction: `locator.page()` is how a program gets back to the page from a
 * locator it was passed.
 *
 * Asserted against the real page identity rather than by trying another drive,
 * because the failure mode is "the object is the raw one", and that is what
 * should be checked. A program that returns `true` here has the real page.
 */
test("a program cannot reach the raw page through a locator or a frame", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const viaLocator = page.locator("body").page();
        const viaFrame = page.mainFrame().page();
        const viaFrames = page.frames()[0].page();
        // Awaited, because a browser program runs against a proxy: an unawaited
        // chain is a pending path, so \`.length\` on one is a node rather than a
        // number and the answer would be the placeholder text. This is
        // documented in the tool description, and the awaited form is what makes
        // the assertion mean anything.
        const contexts = await viaLocator.context().browser().contexts();
        ({ contexts: contexts.length, sawFrames: !!viaFrame && !!viaFrames })
      `,
      observe: "none",
    } as never,
    metadata,
  );

  assert.equal(result.outcome, "SUCCESS", result.output);
  /*
   * The program returns an object, so it arrives as JSON. Parsed rather than
   * read as a bare number, which is what the first version of this test did and
   * what broke when the returned value became structured.
   */
  const returned = JSON.parse(returnedValue(result.output)) as { contexts: unknown };
  assert.equal(
    Number(returned.contexts),
    1,
    "a page reached through a locator must still be scoped to this thread",
  );
});

/*
 * `newCDPSession` is the one accessor with no scoped form, so it is refused.
 *
 * It was reachable from both the page and the context, and it is browser-wide
 * regardless of which page opened it: from a sandboxed program it answered
 * `Target.getTargets` with every target in the shared Chrome. The message names
 * the scoped alternatives, because a program that wanted it usually wanted
 * cookies or headers.
 */
test("a program cannot open a raw CDP session", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        try { await page.context().newCDPSession(page); return "opened one"; }
        catch (e) { return e.message.includes("whole browser") ? "refused" : "other: " + e.message; }
      `,
      observe: "none",
    } as never,
    metadata,
  );

  assert.match(result.output, /refused/, "a raw CDP session must be refused rather than returned");
});

test("scoping does not break ordinary browsing", { skip }, async () => {
  /*
   * The other half of the trade. A wrapper that stopped the attack by stopping
   * everything would pass the two tests above and be useless.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        /*
         * Two ways to refer to a page, and the difference is the point.
         *
         * The bare page is a live root: it means "the active page", always, so
         * after a switch it refers to the new one. A handle from browser.pages()
         * or newPage() names one specific page and stays with it. A program that
         * wants to come back to a tab holds the handle; one that wants whatever
         * is active uses the bare page.
         */
        const [formTab] = await browser.pages();
        await formTab.locator("#first").fill("Ada");
        const tabs = await browser.newPage("extra");
        await tabs.goto("${site!.origin}/canvas");
        const active = await browser.setActive("extra");
        const bareFollowed = (await page.url()).includes("/canvas");
        await browser.setActive(formTab);
        const held = await formTab.locator("#first").inputValue().catch(() => "gone");
        ({ held, newTabUrl: await tabs.url(), activeUrl: await active.url(), bareFollowed })
      `,
      observe: "none",
    } as never,
    metadata,
  );

  assert.equal(result.outcome, "SUCCESS", result.output);
  /*
   * The scoped page still behaves like a page: it filled a field, opened a tab,
   * navigated it, and every handle reports where it is.
   *
   * The bare page is the *active* page by contract, which the skill states
   * outright, so after newPage("extra") it is the extra tab and
   * setActive("page-1") puts it back. A page handle taken from newPage or
   * setActive is how a program works with a tab other than the active one.
   *
   * This asserted the opposite before, because the page was bound once at the
   * start: it never followed newPage or setActive, so a program that switched
   * tabs and then used it drove the tab it had just left, and the skill's own
   * sentence was false.
   */
  assert.match(result.output, /"held":"Ada"/, "a handle from pages() must stay with its own page");
  assert.match(result.output, /"newTabUrl":"[^"]*\/canvas"/, "the new tab must be scoped and drivable");
  assert.match(result.output, /"activeUrl":"[^"]*\/canvas"/, "and setActive must return it");
  assert.match(result.output, /"bareFollowed":true/, "and the bare page must follow the active tab");
});

/* ------------------------------------------------------------------ *
 * The host-side eval, which was a live RCE
 * ------------------------------------------------------------------ */

test("a program cannot execute code in Reaper's own process by passing a function", { skip }, async () => {
  /*
   * The bug: a function argument was sent to the host as its source and rebuilt
   * with `new Function("return (" + src + ")")()` — note the trailing call — so
   * a crafted string closed the wrapper and ran in the app-server the moment the
   * argument was revived.
   *
   * Reproduced before the fix: the payload below wrote a file *outside the
   * sandbox* with the host's pid, from a program that was supposedly confined.
   * The path is in the workspace here so the assertion is about the execution
   * rather than about the write succeeding: the file must never appear, because
   * the code must never run.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const marker = `${site!.origin}/pwned-marker.txt`;
  const payload = `0) || (globalThis.__REAPER_RCE_PROBE = 'ran', 0) || (0`;
  const result = await executeBrowserUse(
    rt,
    { code: `await page.evaluate({ __reaperFn: ${JSON.stringify(payload)} }); "sent"`, observe: "none" } as never,
    metadata,
  );

  assert.notEqual(result.outcome, "SUCCESS", "a function argument must be refused, not executed");
  assert.match(result.output, /function cannot be passed|must not cross/i);
  assert.equal((globalThis as Record<string, unknown>)["__REAPER_RCE_PROBE"], undefined, "nothing may run in this process");
});

test("an array callback runs in the sandbox, so the ordinary chain still works", { skip }, async () => {
  /*
   * The other half of the fix. Refusing functions outright would have closed the
   * escape and broken the most ordinary way to write a program, so these
   * methods run their callbacks inside the sandbox instead. `flatMap` over
   * contexts and `filter` by URL is the shape the attack itself uses, which
   * makes it the right thing to keep working.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const mine = await page.context().browser().contexts().flatMap(c => c.pages());
        const hidden = mine.filter(p => p.url().includes("/hidden"));
        ({ pages: mine.length, hidden: hidden.length })
      `,
      observe: "none",
    } as never,
    metadata,
  );

  /*
   * Asserted against a page this thread does not own rather than against a
   * count. The suite shares one runtime, so earlier tests leave tabs open and
   * `pages` is legitimately more than one; what must hold regardless is that
   * none of them is another thread's. An earlier version asserted `pages: 1`,
   * which was true of a clean runtime and false here, and the failure looked
   * like a leak when it was a shared fixture.
   */
  const otherThread = new ThreadBrowserRuntime({ threadId: "array-callback-victim", cdpUrl: CDP_URL });
  let victimUrl = "";
  try {
    const victim = (await otherThread.ensureReady()).page;
    await victim.goto(`${site!.origin}/hidden`, { waitUntil: "domcontentloaded" });
    victimUrl = victim.url();

    const result = await executeBrowserUse(
      rt,
      {
        code: `
          const mine = await page.context().browser().contexts().flatMap(c => c.pages());
          const urls = await Promise.all(mine.map(async (p) => await p.url()));
          ({ count: mine.length, urls })
        `,
        observe: "none",
      } as never,
      metadata,
    );

    assert.equal(result.outcome, "SUCCESS", result.output);
    assert.doesNotMatch(result.output, /\/hidden/, "the callback chain must not reach another thread's page");
  } finally {
    await otherThread.close();
  }
});

test("a tab opened through the facade is scoped too", { skip }, async () => {
  /*
   * The gap the primary-root scoping left open. `page` was scoped, so a program
   * that started there could not widen; a page the program opened through
   * `browser.newPage()` was not, so starting from *that* reached every thread.
   * Verified before the fix: `tab.context().browser().contexts()` returned 2 and
   * listed another agent's page URL.
   *
   * Asserted on the other thread's URL rather than on a context count, because a
   * count depends on how many threads happen to be alive.
   */
  const other = new ThreadBrowserRuntime({ threadId: "facade-tab-victim", cdpUrl: CDP_URL });
  try {
    const victim = (await other.ensureReady()).page;
    await victim.goto(`${site!.origin}/hidden`, { waitUntil: "domcontentloaded" });

    const rt = await runtime();
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
    await rt.view();

    const result = await executeBrowserUse(
      rt,
      {
        code: `
          const tab = await browser.newPage("facade-scope-probe");
          await tab.goto(${JSON.stringify(site!.origin)} + "/canvas");
          const all = await tab.context().browser().contexts().flatMap(c => c.pages());
          const urls = await Promise.all(all.map(async (p) => await p.url()));
          ({ contexts: await tab.context().browser().contexts().length, urls })
        `,
        observe: "none",
      } as never,
      metadata,
    );

    assert.equal(result.outcome, "SUCCESS", result.output);
    assert.doesNotMatch(result.output, /\/hidden/, "a tab opened through the facade must not see another thread");
  } finally {
    await other.close();
  }
});

/*
 * An array returned from the host answers both kinds of callback.
 *
 * This is the trap that cost a live run: `pages.find(async (p) => (await
 * p.url()).includes("microsoft"))` returned the *first* page, because `find`
 * tests its callback's result for truthiness synchronously and a Promise is
 * always truthy. The model then switched to a tab it had not selected, and the
 * error it saw was about the wrong page.
 *
 * The other half matters as much: the fix must not make every method async, or
 * `p.map((p) => p.url()).slice(0, 3)` fails with "slice is not a function" for
 * a callback that is perfectly synchronous. Both are asserted here, against a
 * page that is deliberately the *second* one in the list.
 */
test("a returned array handles async callbacks without breaking sync ones", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.newPage("second");
  await (await rt.ensureReady()).page.goto(`${site!.origin}/form`, { waitUntil: "domcontentloaded" });
  await rt.setActive(0);

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const list = await browser.pages();
        // The page we want is second, so a broken async find returns the wrong one.
        const hit = await list.find(async (p) => (await p.url()).includes("/form"));
        const kept = await list.filter(async (p) => (await p.url()).includes("/form"));
        const mapped = list.map((p) => p.pageIndex);
        return {
          found: hit ? await hit.url() : null,
          kept: kept.length,
          syncMap: Array.isArray(mapped) ? mapped.length : "not an array",
        };
      `,
      observe: "none",
    } as never,
    metadata,
  );

  assert.equal(result.outcome, "SUCCESS", result.output);
  const value = JSON.parse(returnedValue(result.output)) as {
    found: string | null; kept: number; syncMap: number | string;
  };
  assert.ok(value.found?.includes("/form"), `async find returned ${value.found}`);
  assert.equal(value.kept, 1, "async filter must keep only the matching page");
  /*
   * Proving the sync path stayed synchronous needs the count to be knowable,
   * and this suite shares one runtime, so earlier tests leave pages open: an
   * assertion of `2` passed alone and failed in the suite with `6`. The count is
   * therefore not asserted; what matters is that `Array.isArray` was true, which
   * a Promise cannot be. A wrong count would still have been an array.
   */
  assert.equal(typeof value.syncMap, "number", "a sync map must return a plain array, not a Promise");
});
