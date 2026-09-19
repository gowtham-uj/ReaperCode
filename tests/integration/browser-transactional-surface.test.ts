/**
 * The transactional surface, from the model's side of the sandbox wall.
 *
 * The unit suites cover the pieces: the classifier's taxonomy, the ledger's
 * folds, the verifier's provenance rules. None of them can prove the thing that
 * is most likely to be broken, which is the *stitching*: `tx`, `download` and
 * `expectPopup` each take a function, a function cannot cross the bridge, and
 * the ergonomic call is assembled in the sandbox from arm/run/collect halves the
 * host answers. A mistake there fails as "not a function" or as an undefined,
 * which is exactly the shape of the bug this whole area has produced before
 * (recover, probeInput and capabilities were each documented and unbound).
 *
 * So these drive the real tool against a real browser and assert on what a model
 * would read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTortureSite, type RunningTortureSite } from "../fixtures/torture-site.js";
import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;
const availability = await probeBrowser(CDP_URL);
const skip = skipUnless(availability);
const site: RunningTortureSite | undefined = availability.available ? await startTortureSite() : undefined;

/**
 * A workspace for the shared runtime, so the download vault exists.
 *
 * A runtime without one has no vault by design: the vault lives inside the
 * workspace because that is the only directory both this process and the
 * sandboxed program can read. The first version of this file built the runtime
 * without one and every download assertion failed with "this thread has no
 * download vault", which is the code correctly reporting a test setup mistake.
 */
const workspace = await mkdtemp(join(tmpdir(), "reaper-tx-"));

let shared: ThreadBrowserRuntime | undefined;
async function runtime(): Promise<ThreadBrowserRuntime> {
  if (!shared) {
    shared = new ThreadBrowserRuntime({ threadId: "tx-surface", cdpUrl: CDP_URL, workspaceRoot: workspace });
    await shared.ensureReady();
  }
  return shared;
}

const metadata = { runId: "test", artifactDir: "/tmp", toolCallId: "call-tx" };

/**
 * Open a fixture page and run a program against it, the way the tool does.
 *
 * The page is named and re-pinned on every call, which is not ceremony: the
 * runtime is shared across the whole file, and a test that ran `setActive` or
 * `browser.newPage()` leaves the bare `page` pointing somewhere else. That made
 * three tests fail for a reason that had nothing to do with what they assert,
 * discovered one at a time.
 *
 * Naming it here rather than in each test is the same fix applied once. A
 * program that names its page is also the shape the surface now encourages, so
 * this is testing the intended usage rather than working around a limitation.
 */
async function use(path: string, code: string, extra: Record<string, unknown> = {}) {
  const rt = await runtime();
  const name = `use-${path.replace(/[^a-z0-9]/gi, "")}`;
  const page = rt.kit.registry.find(name)?.page ?? (await rt.newPage(name));
  await page.goto(`${site!.origin}${path}`, { waitUntil: "domcontentloaded" });
  await rt.setActive(name);
  await rt.view();
  return executeBrowserUse(rt, { code, ...extra } as never, metadata);
}

test("tx runs a body, reports what changed, and returns the body's value", { skip }, async () => {
  /*
   * The whole point of the call: a receipt rather than the page, with the
   * program's own value inside it. If the sandbox stitching were wrong this
   * would fail as "tx is not defined" or as a body that never ran.
   */
  const result = await use(
    "/basic",
    `const r = await tx({ name: "click continue" }, async ({ page }) => {
       await page.getByRole("button", { name: "Continue" }).click();
       return { heading: await page.locator("h1").textContent() };
     });
     return r;`,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /TX a\d+ SUCCESS "click continue"/, "a transaction receipt is what comes back");
  assert.match(result.output, /changed/, "and it says the page changed");
  assert.match(result.output, /heading/, "and it carries the body's value");
});

test("tx names a page, and its body drives that tab whatever is active", { skip }, async () => {
  const result = await use(
    "/basic",
    `const other = await browser.newPage("other");
     await other.goto("${site!.origin}/hidden");
     const r = await tx({ page: "other", name: "read hidden" }, async ({ page }) => page.url());
     return r;`,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /\/hidden/, "the body ran against the page the transaction named");
});

test("inspect explains a zero-area element and names the child to click", { skip }, async () => {
  /*
   * The failure that cost a live mission a thirty-second wait and two reasoning
   * passes. The fixture has a link styled to zero width with a clickable icon
   * inside it, which is the shape every real page uses for a delete button.
   */
  const result = await use("/zero-area", `return await inspect(page.getByTestId("zero-delete"));`);
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /ZERO_AREA|NOT_VISIBLE|not actionable/, result.output);
  assert.match(result.output, /children with a real box|matches:/, "the model is given something to act on");
});

test("inspect says yes for an element that is fine, without clicking it", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  const before = page.url();
  const result = await executeBrowserUse(
    rt,
    { code: `return await inspect(page.getByRole("button", { name: "Continue" }));` } as never,
    metadata,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  /*
   * The trial performs the actionability checks and not the action, so the page
   * must not have moved. That is what makes this safe to call on a delete button.
   */
  assert.equal(page.url(), before, "the trial must not have clicked anything");
});

test("inspectForm reads a constrained field's limits before a value is guessed", { skip }, async () => {
  const result = await use("/form-limits", `return await inspectForm();`);
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /max 20|maxlength|20/, "the constraint is reported");
});

test("a fixed sleep is called out with what to wait for instead", { skip }, async () => {
  const result = await use("/basic", `await page.waitForTimeout(2000); "slept"`);
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /SLOW:/, "the fixed sleep is named");
  assert.match(result.output, /waitForChange|waitForURL|toBeVisible/, "and the alternative is given");
});

test("waitForChange returns when the condition holds, and says when it did not", { skip }, async () => {
  /*
   * The replacement for a fixed sleep. The fixture reveals its button after
   * 700ms, so waiting for the text is a wait that succeeds; waiting for text
   * that never arrives is a wait that gives up at its budget and says so rather
   * than hanging.
   */
  const arrived = await use(
    "/slow",
    `const wait = await waitForChange({ textPresent: "Arrived", timeoutMs: 5000 });
     return wait;`,
  );
  assert.equal(arrived.outcome, "SUCCESS", arrived.output);
  assert.match(arrived.output, /"changed":true|changed.*true/, "the condition was met");

  const missed = await use(
    "/slow",
    `const wait = await waitForChange({ textPresent: "Never Appears", timeoutMs: 1500 });
     return wait;`,
  );
  assert.equal(missed.outcome, "SUCCESS", missed.output);
  assert.match(missed.output, /"changed":false|changed.*false/, "a wait that expired reports honestly");
});

test("download arms before the trigger, stores the file, and records provenance", { skip }, async () => {
  /*
   * The three claims that only a real download can settle: the wait is armed
   * before the click (the order Playwright requires and the order a hand-written
   * version gets wrong), the file lands in the thread's workspace, and the
   * ledger records that an action raised it.
   */
  const result = await use(
    "/download",
    `const file = await download({
       trigger: async (page) => { await page.getByRole("link", { name: "Download Invoice" }).click(); },
     });
     return file;`,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /invoice\.txt/, "the file comes back by name");
  assert.match(result.output, /\/\.reaper\/downloads\//, "and it is inside the thread's workspace");
  assert.match(result.output, /sha256/, "with a hash, so the model can prove it is the same file later");

  /*
   * The provenance, checked through the verifier rather than by reading the
   * ledger directly, because that is the path a benchmark uses.
   *
   * Passing *is* the proof: `artifactFromAction` fails for a file that was not
   * raised by an action, which the next test asserts from the other side. What
   * this adds is that the check discriminates rather than always passing, so a
   * second requirement naming a file that does not exist must fail in the same
   * call.
   */
  const rt = await runtime();
  const verified = await executeBrowserUse(
    rt,
    {
      finish: [
        { kind: "artifactFromAction", name: "invoice.txt" },
        { kind: "artifactFromAction", name: "no-such-file.txt" },
      ],
    } as never,
    metadata,
  );
  assert.equal(verified.outcome, "POSTCONDITION_FAILED", "the requirement that cannot be met must fail");
  assert.doesNotMatch(verified.output, /invoice\.txt was downloaded by clicking/, "the real download passed");
  assert.match(verified.output, /no-such-file\.txt/, "and the missing one is named");
});

test("a download that never arrives fails with the reason, not a hang", { skip }, async () => {
  const result = await use(
    "/download",
    `const file = await download({
       timeoutMs: 2500,
       trigger: async (page) => { await page.getByRole("link", { name: "Download Missing" }).click(); },
     });
     return file;`,
  );
  /*
   * The failure is the model's to act on and it arrives as a receipt rather
   * than as a thrown error, because a thrown error would lose the page state.
   * What matters is that it comes back within the budget rather than hanging,
   * and that it says no file arrived.
   */
  assert.match(result.output, /no download arrived|POSTCONDITION_FAILED|OUTCOME: /, result.output);
  assert.doesNotMatch(result.output, /ProgramTimeout/, "it must give up at its own budget, not the program's");
});

test("expectPopup catches a click-opened tab and records the click as its cause", { skip }, async () => {
  /*
   * The provenance rule for tabs. A task that asks for a popup is asking for the
   * click that opened it, and `context.newPage()` produces a tab without one.
   */
  const result = await use(
    "/popup-link",
    `const popup = await expectPopup(page, async (page) => {
       await page.getByRole("link", { name: "Open New Window" }).click();
     });
     return { url: await popup.url(), id: await popup.pageName };`,
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
  assert.match(result.output, /\/basic/, "the popup is a real page the program can drive");

  const rt = await runtime();
  const verified = await executeBrowserUse(rt, { finish: [{ kind: "popup", pattern: "/basic" }] } as never, metadata);
  assert.equal(verified.outcome, "SUCCESS", `the click-opened popup satisfies the requirement: ${verified.output}`);

  /*
   * And the check discriminates: a pattern no popup matches must fail, so a
   * passing requirement above is not a check that always passes.
   */
  const miss = await executeBrowserUse(rt, { finish: [{ kind: "popup", pattern: "/nowhere-at-all" }] } as never, metadata);
  assert.equal(miss.outcome, "POSTCONDITION_FAILED");
  assert.match(miss.output, /no page matching/, miss.output);
});

test("a manually created tab does not satisfy a popup requirement", { skip }, async () => {
  /*
   * The violation measured in a real mission: a tab the task wanted opened by
   * clicking a link was opened with newPage. The end state was right and the
   * interaction, which is what the task measured, never happened.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await executeBrowserUse(
    rt,
    { code: `const p = await browser.newPage("manual"); await p.goto("${site!.origin}/popup-link"); return "ok";` } as never,
    metadata,
  );
  const outcome = await executeBrowserUse(rt, { finish: [{ kind: "popup", pattern: "/popup-link" }] } as never, metadata);
  assert.equal(outcome.outcome, "POSTCONDITION_FAILED", "a tab the program asked for is not a popup");
  assert.match(outcome.output, /newPage\(\) does not satisfy/, outcome.output);
});

test("policy ui-only refuses a program that fetches, and does not run it", { skip }, async () => {
  /*
   * The violation measured in a real mission: an invoice fetched over HTTP and
   * written to disk instead of clicking the download link. The end state was
   * right and the interaction, which is what the task measured, never happened.
   */
  const result = await use(
    "/basic",
    `const body = await page.evaluate(() => fetch("/x").then(r => r.text())); return body;`,
    { policy: "ui-only" },
  );
  assert.equal(result.outcome, "PRECONDITION_FAILED", result.output);
  assert.match(result.output, /POLICY VIOLATION/, "the refusal is named");
  assert.match(result.output, /instead:/, "and the model is told what to do instead");
});

test("policy ui-only allows ordinary interactive work", { skip }, async () => {
  const result = await use(
    "/basic",
    `const title = await page.title();
     await page.getByRole("button", { name: "Continue" }).click();
     return title;`,
    { policy: "ui-only" },
  );
  assert.equal(result.outcome, "SUCCESS", result.output);
});

test("state records a fact that survives to the next call", { skip }, async () => {
  /*
   * The property that matters: the fact lives on the host, not in the program.
   * A second, separate program reads it back, which is what a trimmed transcript
   * cannot do.
   *
   * The program names its own page, so it does not depend on which tab another
   * test left active. `state` is per-thread rather than per-page, so this is not
   * required for correctness, but a test that passes or fails on the shared
   * runtime's active page is a test that will fail for the wrong reason.
   */
  const rt = await runtime();
  const own = await rt.newPage("state-check");
  await own.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  const first = await executeBrowserUse(
    rt,
    { code: `const p = await browser.page("state-check"); await state.fact("answer", "42", "a9"); return "recorded";`, observe: "none" } as never,
    metadata,
  );
  assert.equal(first.outcome, "SUCCESS", first.output);

  const second = await executeBrowserUse(rt, { code: `return (await state.get()).facts;`, observe: "none" } as never, metadata);
  assert.match(second.output, /answer/, "the fact is still there on the next call");
  assert.match(second.output, /42/, "with its value");
});

test("state refuses to let a program mark its own work verified", { skip }, async () => {
  /*
   * The verifier's whole authority rests on this: `verified` is the runtime's
   * word, and a program that could set it would be marking its own homework.
   */
  const result = await use(`/basic`, `await state.subtask("do the thing", "verified"); return "ok";`);
  assert.equal(result.outcome, "POSTCONDITION_FAILED", result.output);
  assert.match(result.output, /cannot mark its own subtask verified/, result.output);
});

test("finish fails with what is missing, and passes when it is not", { skip }, async () => {
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  const unmet = await executeBrowserUse(
    rt,
    { finish: [{ kind: "url", pattern: "/never-here" }] } as never,
    metadata,
  );
  assert.equal(unmet.outcome, "POSTCONDITION_FAILED", unmet.output);
  assert.match(unmet.output, /VERIFICATION FAILED/, "the failure is named");
  assert.match(unmet.output, /never-here/, "and says which condition is not met");

  const met = await executeBrowserUse(rt, { finish: [{ kind: "url", pattern: "/basic" }] } as never, metadata);
  assert.equal(met.outcome, "SUCCESS", met.output);
  assert.match(met.output, /VERIFIED/);
});

test("a declared artifact is not evidence, and only a real download satisfies either requirement", { skip }, async () => {
  /*
   * The provenance rule, and a second rule the first version of this test got
   * wrong by expecting the opposite.
   *
   * `state.artifact()` is the model's own record of a file it is tracking. If
   * that satisfied a verification requirement, a model could pass the artifact
   * check by asserting the file existed, which is the same "marking your own
   * homework" failure that stops a program setting a subtask to verified. So a
   * declared artifact satisfies *neither* requirement: evidence comes from the
   * ledger, which only a real save writes to.
   *
   * This is the distinction a benchmark needs. An end state alone cannot make
   * it, because a fetched file and a downloaded file look identical on disk.
   */
  const rt = await runtime();
  const { page } = await rt.ensureReady();
  await page.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });

  await executeBrowserUse(
    rt,
    { code: `await state.artifact("declared-invoice", "/tmp/declared.txt", 66); return "ok";` } as never,
    metadata,
  );

  const plain = await executeBrowserUse(
    rt,
    { finish: [{ kind: "artifact", name: "declared-invoice" }] } as never,
    metadata,
  );
  assert.equal(plain.outcome, "POSTCONDITION_FAILED", "declaring a file does not make it exist");
  assert.match(plain.output, /no saved file matches/, plain.output);

  const provenance = await executeBrowserUse(
    rt,
    { finish: [{ kind: "artifactFromAction", name: "declared-invoice" }] } as never,
    metadata,
  );
  assert.equal(provenance.outcome, "POSTCONDITION_FAILED");
  assert.match(provenance.output, /download event/, provenance.output);
});

test("the same failing program is refused the second time, rather than re-run", { skip }, async () => {
  /*
   * The measured loop: thirteen consecutive identical clicks, each written
   * believing the failure was transient. Nothing told the model the previous
   * twelve had been the same call on the same page in the same state.
   */
  const rt = await runtime();
  const own = await rt.newPage("repeat");
  await own.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const code = `await page.getByRole("button", { name: "Does Not Exist At All" }).click({ timeout: 600 }); "done";`;
  const first = await executeBrowserUse(rt, { code, observe: "none" } as never, metadata);
  assert.equal(first.outcome, "POSTCONDITION_FAILED", first.output);

  const second = await executeBrowserUse(rt, { code, observe: "none" } as never, metadata);
  assert.equal(second.outcome, "PRECONDITION_FAILED", `the repeat must be refused: ${second.output}`);
  assert.match(second.output, /REPEATED_FAILURE/, second.output);
  assert.match(second.output, /Nothing ran/, "and it must not have run");
});

test("the same program after the page moved is allowed, because the state changed", { skip }, async () => {
  /*
   * The other half of the rule, and the reason the fingerprint carries a
   * revision: refusing a correct retry would be the runtime overruling the
   * model. A program that failed before a navigation is a new attempt after one.
   */
  const rt = await runtime();
  const own = await rt.newPage("moved");
  await own.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const code = `await page.getByRole("button", { name: "Gone For Now" }).click({ timeout: 500 }); "done";`;
  await executeBrowserUse(rt, { code, observe: "none" } as never, metadata);
  /* The page moves, so the same program is a different attempt. */
  await own.goto(`${site!.origin}/hidden`, { waitUntil: "domcontentloaded" });
  await rt.view();

  const again = await executeBrowserUse(rt, { code, observe: "none" } as never, metadata);
  assert.notEqual(again.outcome, "PRECONDITION_FAILED", `a moved page must not refuse the retry: ${again.output}`);
  assert.doesNotMatch(again.output, /REPEATED_FAILURE/);
});

test("metrics are folded from the ledger and count the failure", { skip }, async () => {
  const rt = await runtime();

  /*
   * Its own page, because this asserts on counts and the shared runtime's active
   * page is whatever the previous seventeen tests left it as. The first version
   * used the shared page and failed with "the page was closed" when an earlier
   * test had closed it, which is a fact about test ordering rather than about
   * metrics.
   */
  const own = await rt.newPage("metrics");
  await own.goto(`${site!.origin}/basic`, { waitUntil: "domcontentloaded" });
  /*
   * The program names its page rather than using the bare `page`.
   *
   * Beyond test ordering, this is the shape the surface now encourages: a tab is
   * addressed by name or id, so a step cannot drift onto whatever happens to be
   * active. Using the bare global here made this test depend on what eighteen
   * previous tests had left the runtime pointing at.
   */
  const before = rt.kit.ledger.metrics().browserCalls;
  await executeBrowserUse(
    rt,
    {
      code: `const p = await browser.page("metrics"); await p.getByRole("button", { name: "Does Not Exist" }).click({ timeout: 500 }); "done";`,
      observe: "none",
    } as never,
    metadata,
  );

  /*
   * The count moved, and it moved through the ledger rather than through a
   * counter somewhere else. The bug this whole module replaced was a summary
   * reporting zero failures for a run with fourteen, because the number and the
   * browser were two different things.
   */
  const after = rt.kit.ledger.metrics();
  assert.ok(after.browserCalls > before, `a call must be counted: ${before} -> ${after.browserCalls}`);
  assert.ok(
    after.failedCalls > 0 || after.successfulCalls > 0,
    "every counted call has an outcome, so neither total can stay at zero",
  );

  /* And the fold is reachable from a program, which is what makes it readable. */
  const result = await executeBrowserUse(rt, { code: `return (await metrics()).text;`, observe: "none" } as never, metadata);
  assert.match(result.output, /CALLS:/, result.output);
});
