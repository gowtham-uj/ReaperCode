/**
 * The observation layer: what the model is shown of a page, and how little of it
 * changes between looks.
 *
 * The fixtures are the shape `ariaSnapshotJSON({ mode: "ai", boxes: true })`
 * actually returns, captured from Playwright 1.63 against a live page rather
 * than invented. That shape is what every function here is written against, and
 * it is a real tree of objects now instead of YAML text, which is the whole
 * reason the regular expressions this file used to test are gone.
 *
 * The load-bearing test is the delta one at the end: after an action the model
 * must get a handful of changed lines, not the page again. That property is the
 * difference between a browser agent that works and one that spends its whole
 * context re-reading the same login form.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PageObserver, diffOutlines, trimOutline } from "../../../src/browser/page-view.js";

/**
 * A jobs page, as Playwright renders it.
 *
 * Verbatim `ariaSnapshot({ mode: "ai" })` output, not invented. The observation
 * layer no longer renders anything itself, so the fixture is the exact text the
 * model will be shown.
 */
const JOBS_PAGE = `- generic [active] [ref=e1]:
  - heading "Software Engineer" [level=1] [ref=e2]
  - paragraph [ref=e3]: San Francisco, CA
  - textbox "Search jobs" [ref=e5]
  - button "Search" [ref=e6]
  - list [ref=e7]:
    - listitem [ref=e8]:
      - link "AI Engineer" [ref=e9] [cursor=pointer]:
        - /url: /j/1
      - button "Save job 1" [ref=e10]: Save
    - listitem [ref=e11]:
      - link "Platform Engineer" [ref=e12] [cursor=pointer]:
        - /url: /j/2
  - contentinfo [ref=e13]:
    - link "About" [ref=e14] [cursor=pointer]:
      - /url: /about`;

const JOBS_OUTLINE = JOBS_PAGE;

/** A single job's page, for the navigation case. */
const JOB_PAGE = `- heading "AI Engineer" [level=1] [ref=e2]
- paragraph [ref=e3]: OpenAI
- button "Apply" [ref=e4]`;

test("an unchanged page says so rather than repeating itself", () => {
  const diff = diffOutlines(JOBS_OUTLINE, JOBS_OUTLINE);
  assert.equal(diff.text, "(no change)");
  assert.equal(diff.full, false);
});

test("the first observation is the full outline, because there is nothing to diff against", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x/jobs", title: "Jobs", snapshot: JOBS_PAGE });
  const view = observer.view();
  assert.match(view.text, /URL: https:\/\/x\/jobs/);
  assert.match(view.text, /Title: Jobs/);
  assert.match(view.text, /heading "Software Engineer"/);
});

test("after an action the model gets a delta, not the page again", () => {
  /*
   * The property the whole design exists for, in the shape it actually occurs:
   * the page is mostly the same and one region changed. Here the model filled a
   * form and a validation error appeared — the page is still the page, and
   * re-sending it would cost the same tokens as the first look on every step of
   * every task.
   */
  const FORM_PAGE = `- heading "Apply for AI Engineer" [level=1] [ref=e1]
- textbox "First name" [ref=e2]
- textbox "Last name" [ref=e3]
- textbox "Email" [ref=e4]
- combobox "Country" [ref=e5]
- button "Continue" [ref=e6]`;

  const observer = new PageObserver();
  observer.capture({ url: "https://x/apply", title: "Apply", snapshot: FORM_PAGE });
  const first = observer.view();
  const firstCost = first.text.length;

  // The model filled the form and hit Continue; the server rejected the email.
  const AFTER = `${FORM_PAGE}\n- alert "Email is required" [ref=e7]`;
  observer.capture({ url: "https://x/apply", title: "Apply", snapshot: AFTER });
  const changes = observer.viewChanges();

  assert.match(changes.text, /Added:/);
  assert.match(changes.text, /Email is required/, "the new error is the actionable fact");
  assert.match(changes.text, /URL unchanged/, "and the model is told the click did not navigate");
  assert.ok(
    changes.text.length < firstCost * 0.5,
    `a delta must be much cheaper than the page (was ${changes.text.length} vs ${firstCost})`,
  );
});

test("a wholesale change returns the page rather than a diff that lists all of it", () => {
  /*
   * The other half of the rule: a diff is only useful when the page is mostly
   * recognisable. After a navigation where nothing carries over, listing every
   * changed line is longer than the page and harder to read, so the full
   * outline is the cheaper answer.
   */
  const observer = new PageObserver();
  observer.capture({ url: "https://x/jobs", title: "Jobs", snapshot: JOBS_PAGE });
  observer.view();

  observer.capture({ url: "https://x/jobs/1", title: "AI Engineer", snapshot: JOB_PAGE });
  const changes = observer.viewChanges();

  assert.equal(changes.full, true);
  assert.match(changes.text, /AI Engineer/);
  assert.match(changes.text, /URL: https:\/\/x\/jobs\/1/, "a full view carries its own url header");
});

test("a second look with no change reports the URL and nothing else", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x/a", title: "A", snapshot: JOBS_PAGE });
  observer.view();
  observer.viewChanges();
  const again = observer.viewChanges();
  assert.match(again.text, /no change/);
  assert.match(again.text, /URL unchanged/, "the URL is still the most useful fact after a no-op action");
});

test("the revision advances so a caller can tell one observation from the next", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: JOBS_PAGE });
  assert.equal(observer.revision, 0);
  observer.view();
  assert.equal(observer.revision, 1);
  observer.viewChanges();
  assert.equal(observer.revision, 2);
});

test("reset clears the diff baseline so a new task does not diff against an old page", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: JOBS_PAGE });
  observer.view();
  observer.reset();
  observer.capture({ url: "https://y", title: "u", snapshot: JOB_PAGE });
  // After a reset the model has seen nothing, so the diff must be the page.
  const changes = observer.viewChanges();
  assert.match(changes.text, /Software Engineer|AI Engineer/);
  assert.equal(changes.full, true);
});

test("every observation carries its revision and the URL", () => {
  /*
   * The revision is what makes two similar observations distinguishable. After
   * an action that changes nothing, the outline is identical to the last one —
   * and without a revision number the model cannot tell "my action was seen and
   * changed nothing" from "my action was never observed".
   */
  const observer = new PageObserver();
  observer.capture({ url: "https://x/a", title: "A", snapshot: JOBS_PAGE });
  const first = observer.view();
  assert.match(first.text, /^REV 1\nURL: https:\/\/x\/a/);

  observer.capture({ url: "https://x/a", title: "A", snapshot: JOBS_PAGE });
  const second = observer.viewChanges();
  assert.match(second.text, /^REV 2/, "the revision advances even when the page did not");
  assert.match(second.text, /URL: https:\/\/x\/a/, "the url rides on a delta too");
});

test("a goal and step ride along, so the model knows where it is in a task", () => {
  const observer = new PageObserver();
  observer.setGoal("Complete the job application");
  observer.setStep("Contact information");
  observer.capture({ url: "https://x/apply", title: "Apply", snapshot: JOBS_PAGE });
  const view = observer.view();
  assert.match(view.text, /Goal: Complete the job application/);
  assert.match(view.text, /Current step: Contact information/, "the step is the model's own context, carried for it");
});

test("the default view budget keeps a step inside a few hundred tokens", () => {
  // The budget the design is built around: a browsing step should cost
  // hundreds of tokens, not thousands. A page whose outline exceeds it is
  // trimmed and says so, so the model can scope rather than guess.
  const many = Array.from({ length: 400 }, (_, i) => `  - link "Item number ${i}" [ref=e${i}]`).join("\n");
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: many });
  const view = observer.view();
  assert.ok(view.text.length <= 3_200, `a default view must stay near its budget, was ${view.text.length}`);
  assert.equal(view.truncated, true, "and it must say it was cut");
  assert.match(view.text, /view\(\{ selector \}\) for one region/);
});

/* ------------------------------------------------------------------ *
 * Stats and provenance, ported from browserclaw
 *
 * A snapshot that reports what it cost turns "the model cannot see the button"
 * into a measurement. `interactive: 0` on a page with content means the
 * accessibility tree is not describing the page; a high `chars` with
 * `truncated` means the budget cut something off. Without these the only way to
 * tell the two apart is to rerun and instrument.
 * ------------------------------------------------------------------ */

test("an observation counts what it contains", () => {
  const observer = new PageObserver();
  observer.capture({ url: "https://x/jobs", title: "Jobs", snapshot: JOBS_PAGE });
  const view = observer.view();

  assert.ok(view.stats.lines > 0);
  assert.ok(view.stats.chars > 0);
  assert.ok(view.stats.refs > 0, "the fixture has refs");
  assert.ok(view.stats.interactive > 0, "the fixture has links and buttons");
  // The counts must describe the outline that was actually sent.
  assert.equal(view.stats.chars, JOBS_PAGE.length);
  assert.equal(view.stats.lines, JOBS_PAGE.split("\n").filter((l) => l.trim()).length);
});

test("a page with no interactive element reports zero, which is a finding", () => {
  // The canvas case: real markup, nothing actionable. A model told "0
  // interactive" knows to escalate to a screenshot rather than conclude the
  // page is empty.
  const observer = new PageObserver();
  observer.capture({ url: "https://x/canvas", title: "Canvas", snapshot: '- heading "Canvas" [ref=e1]\n- img "chart" [ref=e2]' });
  const view = observer.view();
  assert.equal(view.stats.interactive, 0);
  assert.equal(view.stats.refs, 2, "both elements are still counted");
});

test("a truncated observation says so in its stats", () => {
  const many = Array.from({ length: 400 }, (_, i) => `  - link "Item number ${i}" [ref=e${i}]`).join("\n");
  const observer = new PageObserver();
  observer.capture({ url: "https://x", title: "t", snapshot: many });
  const view = observer.view();
  assert.equal(view.truncated, true);
  assert.ok(view.stats.chars <= 3_200, "the stats describe what was sent, not what was available");
});

test("every observation is marked as untrusted page content", () => {
  /*
   * The boundary that matters most and is easiest to forget. Page text is
   * attacker-controlled, and a "system" line rendered inside a page arrives in
   * the same channel as real instructions. Marking it means anything downstream
   * can tell the two apart by construction rather than by remembering.
   */
  const observer = new PageObserver();
  observer.capture({ url: "https://evil.example", title: "t", snapshot: JOBS_PAGE });
  const view = observer.view();
  assert.equal(view.contentMeta.untrusted, true);
  assert.equal(view.contentMeta.source, "browser-page");
  assert.equal(view.contentMeta.url, "https://evil.example", "provenance survives the boundary");
});

test("the state signature tracks the page, not the number of looks", () => {
  /*
   * The reader that keeps a refusal tied to the page.
   *
   * The observation counter cannot answer "has the page moved", because it moves
   * on every look. A refusal keyed on it was released by the model glancing at
   * the page, which is the one thing a model in a loop does between attempts. The
   * signature is the URL plus the outline's size, so a look leaves it alone and a
   * real change moves it.
   */
  const observer = new PageObserver();
  observer.capture({ url: "https://x/jobs", title: "Jobs", snapshot: JOBS_PAGE });
  const before = observer.stateSignature();
  observer.view();
  observer.view();
  assert.equal(observer.stateSignature(), before, "reading the page twice is not a change to it");

  observer.capture({ url: "https://x/jobs", title: "Jobs", snapshot: `${JOBS_PAGE}\n- paragraph [ref=e99]: An error appeared` });
  assert.notEqual(observer.stateSignature(), before, "content that appeared moves the signature");

  observer.capture({ url: "https://x/job/2", title: "Job", snapshot: JOB_PAGE });
  const movedUrl = observer.stateSignature();
  assert.match(movedUrl, /^https:\/\/x\/job\/2#/, "and so does a navigation");
});
