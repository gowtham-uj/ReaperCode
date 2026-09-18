/**
 * Does a helper's argument reach the host when the program runs for real?
 *
 * End-to-end through the shipped path: `executeBrowserUse` -> `runProgram` ->
 * the real `CODE_MODE_WORKER_SOURCE` in a worker thread -> the real frame
 * normalizer -> `BrowserProgramHost.observeCall` -> the real control surface.
 * Only the browser is a fixture; every stage between the program and the
 * control is the code that ships.
 *
 * This exists because the unit tests around this surface read the source as
 * text. A regex over `remote-page-source.ts` proves a control is named and says
 * nothing about whether its argument arrives, and the defect being pinned here
 * was exactly that: the worker sent `[name, ...args]` while the host
 * destructured `[method, called, ...args]`, so a helper's first argument was
 * consumed as the call flag and everything after it slid one position left.
 *
 * What that looked like from the model's side, all of it a wire bug rather than
 * a misused API:
 *
 *   setUserAgent('UA-X')  -> "userAgent must be a non-empty string"
 *   setViewport(1024,768) -> "height must be a positive number, got NaN"
 *   blockAds(true)        -> reported blockAds as false
 *   bandwidth({...})      -> arrived holding nothing
 *
 * The zero-argument helpers kept working, which is the tell: they dispatched
 * correctly and their missing flag was indistinguishable from an absent
 * argument. So the check is by arity, and it runs the real worker because a
 * stubbed host is the one thing that cannot catch this.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;
const availability = await probeBrowser(CDP_URL);
const skip = skipUnless(availability);

let shared: ThreadBrowserRuntime | undefined;
async function runtime(): Promise<ThreadBrowserRuntime> {
  if (!shared) {
    shared = new ThreadBrowserRuntime({ threadId: "helper-args", cdpUrl: CDP_URL });
    await shared.ensureReady();
  }
  return shared;
}

const metadata = { runId: "test", artifactDir: "/tmp", toolCallId: "call-1" };
const use = async (code: string) => executeBrowserUse(await runtime(), { code }, metadata);

/*
 * The runtime holds a live connection, so it is closed on the way out.
 *
 * Without this the suite passes every assertion and then hangs: node's test
 * runner waits for the event loop to drain, and an open socket to the browser
 * never drains. Measured, and it is a worse failure than a red test, because the
 * output shows all green and a timeout.
 */
test.after(async () => {
  await shared?.close();
  shared = undefined;
});

test("setUserAgent('UA-X') reaches the control instead of arriving empty", { skip }, async () => {
  const result = await use(`return await setUserAgent('UA-X');`);
  assert.doesNotMatch(result.output, /must be a non-empty string/, result.output);
  assert.match(result.output, /UA-X|userAgent/i, result.output);
});

test("setViewport(1024, 768) receives both numbers", { skip }, async () => {
  /*
   * The off-by-one in its clearest form. With the shape mismatch, the host read
   * `(768, undefined)` and reported the *height* as NaN for a call that supplied
   * it, while dropping the width.
   */
  const result = await use(`return await setViewport(1024, 768);`);
  assert.doesNotMatch(result.output, /must be a positive number/, result.output);
  assert.match(result.output, /1024/, result.output);
  assert.match(result.output, /768/, result.output);
});

test("blockAds(true) and setFullscreen(true) receive true, not false", { skip }, async () => {
  /*
   * A boolean argument that arrives missing reads as `args[0] === true` being
   * false, so the call reported the setting as off after being asked for on.
   * The assertion is on the returned state rather than on the absence of an
   * error, because this one did not error at all: it silently did the opposite.
   */
  const result = await use(`
    const out = {};
    out.ads = await blockAds(true);
    out.full = await setFullscreen(true);
    return out;
  `);
  assert.doesNotMatch(result.output, /"blockAds":false|blockAds.*false/, result.output);
});

test("bandwidth({blockImages:true}) arrives with its options", { skip }, async () => {
  const result = await use(`return await bandwidth({ blockImages: true });`);
  assert.match(result.output, /blockImages/, result.output);
});

test("a zero-argument helper still works, so the fix did not trade one arity for the other", { skip }, async () => {
  /*
   * The regression guard in the other direction. The fix gives `view` the same
   * three-element frame a Playwright call uses, and a zero-argument helper sends
   * the same shape with an empty tail. If that frame were wrong, every helper
   * would break rather than the argument-taking ones, so both arities are
   * pinned.
   *
   * The page is opened here rather than assumed. These tests share one runtime,
   * and an earlier one can leave the thread with no page at all, which makes a
   * call fail for a reason that has nothing to do with argument passing. A test
   * that depends on its neighbours' state reports their failures as its own.
   */
  const result = await use(`
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const s = await settings();
    return { keys: Object.keys(s), hasUserAgent: JSON.stringify(s).includes('userAgent') };
  `);
  assert.doesNotMatch(result.output, /is not an observation helper/, result.output);
  assert.match(result.output, /"hasUserAgent":true/, result.output);
});

test("view() with a locator scopes to that region", { skip }, async () => {
  /*
   * The silent half of the same bug. `view(locator)` arrived with no target and
   * rendered the whole page, so a program that asked for a region paid for the
   * page and never learned why.
   *
   * The comparison is made on the view text the program itself received, not on
   * the tool result around it. The result wraps the value in a receipt with a
   * REV/URL/Title header and may append a page block, and measuring that would
   * be measuring the wrapper: an earlier version of this test compared whole
   * outputs, found the scoped one *larger*, and was about to be read as a
   * scoping bug when the region actually came back correctly at 100 characters.
   */
  const result = await use(`
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
    const region = await view(page.locator('h1'));
    const whole = await view();
    return { region, wholeLen: whole.length, hasHeading: region.includes('Example Domain'), hasParagraph: region.includes('This domain is for use') };
  `);

  assert.match(result.output, /"hasHeading":true/, "the scoped view must contain the heading it asked for");
  assert.match(
    result.output,
    /"hasParagraph":false/,
    "and must not contain the sibling paragraph, which is what proves it was scoped rather than whole",
  );
});
