/**
 * The vertical slice, end to end, exactly as the model will use it.
 *
 *     open page -> see the button -> write Playwright -> click
 *       -> page changes -> Reaper sees it -> the model gets the diff
 *
 * This file exists because everything else in the browser layer was built
 * horizontally around it, and a layer that works in isolation and does not
 * compose is a layer that does not work. Nothing here mocks: a real Chrome
 * driven over CDP by a real runtime, against the fixture site.
 *
 * Each test asserts one link of the chain, so a failure names the link rather
 * than reporting that the slice is broken. The last test is the whole chain,
 * which is the only assertion that proves the parts compose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTortureSite, type RunningTortureSite } from "../fixtures/torture-site.js";
import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowsers } from "../../src/app-server/thread-browsers.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { renderReceipt } from "../../src/browser/transaction.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;

/*
 * The probe says which kind of unavailable this is, so a crashed Steel does not
 * report as an absent one. That distinction is the whole reason it exists: this
 * suite skipped seven tests while Steel was dying on every new page, and a skip
 * looks exactly like a machine that never started a browser.
 */
const availability = await probeBrowser(CDP_URL);
const site: RunningTortureSite | undefined = availability.available ? await startTortureSite() : undefined;
const skip = skipUnless(availability);

/**
 * One runtime, shared by every test.
 *
 * It was one per test, which left a browser connection and a context open after
 * each one. The assertions all passed and the process then never exited: node's
 * test runner waits for the event loop to drain, and six abandoned Playwright
 * connections keep sockets alive forever. A suite that passes and hangs is worse
 * than one that fails, because CI reports it as a timeout with no failing test
 * to look at.
 *
 * Sharing is safe here for the same reason it is safe in production: each test
 * navigates the page before it asserts, so no test inherits another's state.
 */
let shared: ThreadBrowserRuntime | undefined;
async function runtime(): Promise<ThreadBrowserRuntime> {
  if (!shared) {
    shared = new ThreadBrowserRuntime({ threadId: "slice", cdpUrl: CDP_URL });
    await shared.ensureReady();
  }
  return shared;
}

test("the model can see a button and address it", { skip }, async () => {
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
    const view = await rt.view();

    /*
     * The two halves of perception, and both have to hold. Seeing the element
     * without a locator means the model can write a program that cannot run;
     * having a locator it cannot see the reason for means the model does not
     * know the button exists.
     */
    assert.match(view.text, /button "Continue"/, "the button must be in the view");
    assert.ok(view.stats.interactive > 0, `the stats must count it: ${JSON.stringify(view.stats)}`);
    assert.equal(view.contentMeta.untrusted, true, "page text is never instructions");
  }
});

test("clicking changes the page, and the change is reported", { skip }, async () => {
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
    await rt.view();

    const { receipt } = await rt.step((target) => target.getByRole("button", { name: "Continue" }).click());

    assert.equal(receipt.outcome, "SUCCESS", renderReceipt(receipt));
    assert.equal(receipt.navigated, false, "the form submit is prevented, so no navigation");
    assert.match(receipt.changes, /submitted/, "the text the click produced must be in the diff");
    assert.ok(receipt.after > receipt.revision, "the revision must advance");
  }
});

test("a click that changes nothing says NO_CHANGE rather than success", { skip }, async () => {
  /*
   * The single most important outcome in the set. An agent told "ok" clicks
   * Continue six times and reports the task done; an agent told "error" gives
   * up on a button that worked. `NO_CHANGE` is the third answer and it has to
   * exist, because those two are both wrong and both are what a boolean gives
   * you.
   */
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/canvas`, { waitUntil: "domcontentloaded" });
    await rt.view();

    // The canvas has no listener. Clicking it is a real click that really does
    // nothing, which is exactly the case that must not read as success.
    const { receipt } = await rt.step((target) => target.locator("#c").click({ position: { x: 5, y: 5 } }));

    assert.equal(receipt.outcome, "NO_CHANGE", renderReceipt(receipt));
    assert.match(receipt.note, /did not change/);
  }
});

test("acting on a stale revision is refused, not attempted", { skip }, async () => {
  /*
   * The failure the whole revision scheme exists for. A model holding a
   * revision from before the page moved is about to click something that has
   * been replaced, and on a page with a Delete button that is how an agent
   * destroys the wrong record.
   */
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
    await rt.view();
    const stale = rt.observer.revision;

    // The model looks again, which advances the revision.
    await rt.view();

    const { receipt } = await rt.step((target) => target.getByRole("button", { name: "Continue" }).click(), { expectedRevision: stale });
    assert.equal(receipt.outcome, "STALE_REVISION", renderReceipt(receipt));
    assert.match(receipt.note, /revision/);
  }
});

test("a control replaced after a click is re-resolved rather than lost", { skip }, async () => {
  /*
   * The fixture's /mutation page replaces the button with a new element of the
   * same name on click. A model that holds the old handle gets a stale-element
   * error; a model that gets the diff sees what actually happened and can act
   * again.
   */
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/mutation`, { waitUntil: "domcontentloaded" });
    await rt.view();

    const { receipt } = await rt.step((target) => target.locator("#go").click());
    assert.equal(receipt.outcome, "SUCCESS", renderReceipt(receipt));
    assert.match(receipt.changes, /Moved on/, "the new content must be in the diff");

    // The page is re-read, and the replacement button is addressable.
    const after = await rt.view();
    assert.match(after.text, /Continue/, "the replacement carries the same name");
  }
});

test("content that arrives late is waited for, not missed", { skip }, async () => {
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    /*
     * The baseline is taken with the page loaded but its late content absent.
     *
     * This is the whole point of the fixture, and it took two attempts to get
     * right. The first version slept 900ms and was flaky under load. The second
     * waited for the button, which was correct in itself, but left the baseline
     * being captured *after* the wait: by then the button had already arrived, so
     * the diff was legitimately empty and the test failed for a reason that had
     * nothing to do with the behaviour it was checking.
     *
     * So the capture is explicit and the wait happens inside the step, which is
     * where it belongs: the step is "wait for the thing to appear", and what is
     * asserted is that the appearance shows up in the receipt.
     */
    await page.goto(`${site!.origin}/slow`, { waitUntil: "domcontentloaded" });
    await rt.capture(page);
    await page.waitForTimeout(100);
    await rt.capture(page);

    const { receipt } = await rt.step(async (target) => {
      await target.locator("#late-btn").waitFor({ state: "attached", timeout: 8_000 });
      return null;
    }, { settle: { timeoutMs: 5_000 } });

    assert.equal(receipt.outcome, "SUCCESS", renderReceipt(receipt));
    assert.match(receipt.changes, /Arrived/, "the late content must be in the diff");
  }
});

test("the whole chain: open, see, act, observe", { skip }, async () => {
  /*
   * The slice in one test, in the order the model does it, asserting the thing
   * the design is actually for: after an action the model is told what changed,
   * in fewer tokens than the page.
   */
  const rt = await runtime();
  {
    const { page } = await rt.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

    const first = await rt.view();
    assert.match(first.text, /button "Continue"/);

    const { receipt } = await rt.step((target) => target.getByRole("button", { name: "Continue" }).click());
    const rendered = renderReceipt(receipt);

    assert.equal(receipt.outcome, "SUCCESS");
    assert.match(rendered, /OUTCOME: SUCCESS/);
    assert.match(rendered, /submitted/);
    assert.ok(
      rendered.length < first.text.length,
      `the delta must cost less than the page: ${rendered.length} vs ${first.text.length}`,
    );
  }
});

/*
 * A thread's browser state survives being closed and reopened.
 *
 * This was broken in a way that produced no error at all: `save()` existed but
 * only the *model* could reach it, nothing called it on the way out, and no
 * state file was ever written. So every thread began from a clean context and
 * every login was lost the moment the idle reaper closed the browser. The
 * symptom is a user signing in to the same site every session and never being
 * told why.
 *
 * Asserted through a real close and reopen, because the failure was in the
 * wiring rather than in the serialization: the save and load functions were
 * both correct, and neither was called.
 */
test("a thread's cookies survive its browser being closed and reopened", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-persist-"));
  const statePath = join(root, "state.json");
  try {
    const first = new ThreadBrowserRuntime({ threadId: "persist-check", cdpUrl: CDP_URL, statePath });
    const { context, page } = await first.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await context.addCookies([{ name: "sid", value: "PERSIST-ME", domain: new URL(site!.origin).hostname, path: "/" }]);

    // A step persists on its own, without the model asking.
    await first.step(async () => "noop").catch(() => undefined);
    assert.equal(existsSync(statePath), true, "a completed step must write the thread's state");

    // Closing is the reaper's path, and it must also persist.
    await first.close();
    assert.equal(existsSync(statePath), true);

    const second = new ThreadBrowserRuntime({ threadId: "persist-check", cdpUrl: CDP_URL, statePath });
    try {
      const reopened = (await second.ensureReady()).context;
      const cookies = await reopened.cookies(site!.origin);
      assert.equal(
        cookies.some((cookie) => cookie.name === "sid" && cookie.value === "PERSIST-ME"),
        true,
        "the cookie must still be there after a reopen",
      );
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * A thread's open pages survive a restart, not just its cookies.
 *
 * Cookies restore a login but not the work: a thread with three tabs open came
 * back as one blank page, and the agent redid the navigation that got it there.
 * The pages are the thread's working state and they were the one part of it
 * nothing persisted.
 *
 * The names and the active page are asserted alongside the URLs, because the
 * agent addresses pages by name and "the page I was on" is part of the state: a
 * restore that returned the right URLs under different names would be a thread
 * whose own instructions no longer resolved.
 */
test("a thread's pages, names and active tab survive a restart", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-pages-"));
  const statePathFor = (threadId: string): string => join(root, `${threadId}.json`);
  try {
    const first = new ThreadBrowsers({ cdpUrl: CDP_URL, statePathFor });
    const runtime = first.forThread("pages-check");
    const { page } = await runtime.ensureReady();
    await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    const second = await runtime.newPage("second");
    await second.goto(`${site!.origin}/form`, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    await runtime.save();

    // A fresh registry over the same state files stands in for a restarted server.
    const restarted = new ThreadBrowsers({ cdpUrl: CDP_URL, statePathFor });
    try {
      const reopened = restarted.forThread("pages-check");
      const pages = await reopened.pageTargets();
      const urls = pages.map((entry) => entry.url);
      assert.equal(urls.length >= 2, true, `expected both pages back, got ${JSON.stringify(urls)}`);
      assert.equal(pages.some((entry) => entry.name === "second"), true, "the name must survive, since the agent addresses pages by it");
      assert.equal(pages.some((entry) => entry.active && entry.url.includes("/form")), true, "the active page must be the one the thread was on");
      assert.equal((await reopened.setActive("second")).url().includes("/form"), true, "setActive by name must still resolve");
    } finally {
      await restarted.close();
    }
    await first.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.after(async () => {
  /*
   * Both handles are closed, and the runtime is dropped, so the event loop can
   * drain. This is the difference between a suite that exits and one that hangs
   * after passing everything.
   */
  await shared?.close();
  shared = undefined;
  await site?.close();
});
