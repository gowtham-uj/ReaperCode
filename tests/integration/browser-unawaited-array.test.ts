/**
 * The missing-await mistake, and what the model is told about it.
 *
 * Every array method with an async callback returns a promise, and a model
 * writes `const blank = pages.find(async (p) => (await p.url()) === "x")` then
 * `blank.goto(...)` without noticing. JavaScript's own message for that is
 * `blank.goto is not a function`, which is true and names nothing: the cause is
 * one line up and the model, read from a live mission, spent turns rewriting the
 * surrounding code rather than adding the word `await`.
 *
 * The unit tests covered the proxy's *success* path (an async callback resolves
 * to the right page) and never this one. That is the gap: the failing path is
 * where a model actually is when it needs the message.
 *
 * Driven through the real sandbox, because the proxy is emitted as source and
 * the wrapping happens inside it. A test against the TypeScript would not touch
 * the code that runs.
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
    shared = new ThreadBrowserRuntime({ threadId: "await-check", cdpUrl: CDP_URL });
    await shared.ensureReady();
  }
  return shared;
}

const metadata = { runId: "test", artifactDir: "/tmp", toolCallId: "call-await" };

test("calling a method on an un-awaited find explains the missing await", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  /*
   * The model's own code, verbatim in shape. The program is expected to fail;
   * what is asserted is that the failure says why.
   */
  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const all = await browser.pages();
        const blank = all.find(async (p) => (await p.url()) === "about:blank");
        await blank.goto("${site!.origin}/hidden");
        return "done";
      `,
      observe: "none",
    } as never,
    metadata,
  );

  assert.equal(result.outcome, "POSTCONDITION_FAILED", result.output);
  /*
   * The three things the message has to carry: the word `await`, the method it
   * belongs to, and the fact that the "is not a function" complaint is a symptom
   * rather than a broken method. A message with only the first would leave the
   * model wondering which call.
   */
  assert.match(result.output, /await/, "the fix must be named");
  assert.match(result.output, /find/, "and the call it applies to");
  assert.match(result.output, /is not a function.*await is missing|await is missing/, "and the cause, not just the symptom");
});

test("the same call with the await works, so the trap does not break ordinary code", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const all = await browser.pages();
        const hit = await all.find(async (p) => (await p.url()).includes("/basic"));
        return hit ? await hit.title() : "none";
      `,
      observe: "none",
    } as never,
    metadata,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /Basic form/, "the awaited form must still resolve to the page");
});

test("awaiting the promise directly still works, because then is forwarded", { skip }, async () => {
  /*
   * The wrapper must not break the one thing that *should* work. If it swallowed
   * `then`, every awaited array call in every program would hang or return the
   * wrapper, which would be a far worse bug than the one it fixes.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  const result = await executeBrowserUse(
    rt,
    {
      code: `
        const all = await browser.pages();
        const count = await all.find(async (p) => (await p.url()).includes("/basic")).then(() => 1);
        const filtered = await all.filter(async (p) => (await p.url()).includes("/basic"));
        return { count, filtered: filtered.length };
      `,
      observe: "none",
    } as never,
    metadata,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /"count":1/, "then() must reach the real promise");
  assert.match(result.output, /"filtered":1/, "and filter must still resolve to an array");
});

test.after(async () => {
  await shared?.close();
  shared = undefined;
  await site?.close();
});
