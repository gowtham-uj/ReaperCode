/**
 * The task ledger, and the three properties that make it worth having.
 *
 * Each test below is one of the ways a ledger goes wrong. A ledger that grows
 * unboundedly is history again; one that reports a mechanic's repair as news
 * teaches the model to distrust it; one that cannot tell the agent's work from
 * the user's has the model redo a person's edit or skip it entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { LEDGER_MAX_CHARS, LEDGER_MAX_DONE, TaskLedger } from "../../../src/browser/task-ledger.js";

test("a fresh ledger renders nothing, so a plain task is not padded with 'none'", () => {
  assert.equal(new TaskLedger().render(), "");
});

test("a ledger with only a goal renders one line", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply to AI Engineer");
  assert.equal(ledger.render(), "GOAL      Apply to AI Engineer");
});

test("the block reads as the thing the model needs: goal, done, current, next, blockers", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply to AI Engineer");
  ledger.complete("opened job", { key: "open" });
  ledger.complete("application started", { key: "start" });
  ledger.complete("contact info", { key: "contact" });
  ledger.setCurrent("demographics");
  ledger.setNext("review (likely)");

  const rendered = ledger.render();
  assert.match(rendered, /^GOAL {6}Apply to AI Engineer$/m);
  assert.match(rendered, /^DONE {6}x opened job, x application started, x contact info$/m);
  assert.match(rendered, /^CURRENT {3}demographics$/m);
  assert.match(rendered, /^NEXT {6}review \(likely\)$/m);
  // Nothing to report means no line at all, rather than "BLOCKERS  none".
  assert.doesNotMatch(rendered, /BLOCKERS/);
  assert.doesNotMatch(rendered, /CHANGED/);
});

test("five field fills on one form collapse to one entry", () => {
  /*
   * The collapsing rule, at the scale it actually occurs. A script fills four
   * fields and clicks Continue; that is one step of a task, and a ledger that
   * listed it five times would be the history it exists to replace.
   */
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  for (const field of ["first name", "last name", "email", "phone"]) {
    ledger.complete(`filled ${field}`, { key: "contact-form" });
  }
  assert.equal(ledger.snapshot().done.length, 1, "the same key supersedes rather than accumulates");
  assert.match(ledger.render(), /filled phone/, "and it reports the latest fact about that subject");
  assert.doesNotMatch(ledger.render(), /filled first name/, "not the sequence of edits to it");
});

test("entries without a key accumulate, because distinct steps are distinct", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.complete("opened job");
  ledger.complete("answered a screening question");
  assert.equal(ledger.snapshot().done.length, 2);
});

test("the DONE list is bounded, and bounded by dropping the oldest", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("long task");
  for (let i = 0; i < LEDGER_MAX_DONE + 6; i++) ledger.complete(`step ${i}`);
  const done = ledger.snapshot().done;
  assert.equal(done.length, LEDGER_MAX_DONE);
  assert.equal(done[0]!.text, "step 6", "the oldest are the ones that go");
  assert.equal(done.at(-1)!.text, `step ${LEDGER_MAX_DONE + 5}`, "the most recent work survives");
});

test("finishing a step clears a blocker, because the thing that was stuck moved", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.addBlocker("CAPTCHA on step 3");
  assert.match(ledger.render(), /BLOCKERS {2}CAPTCHA on step 3/);
  ledger.complete("solved the CAPTCHA");
  assert.doesNotMatch(ledger.render(), /BLOCKERS/);
});

test("adopting a user edit does not clear a blocker, because it is not evidence of progress", () => {
  /*
   * The bug this test exists for: `complete` clears blockers, and adopting a
   * user edit calls `complete`. A handback that happened during a CAPTCHA would
   * have dropped the blocker and left the model believing the way was clear.
   */
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.addBlocker("CAPTCHA on step 3");
  ledger.recordUserChange("location", "Dallas");
  ledger.adoptUserChanges();
  assert.match(ledger.render(), /BLOCKERS {2}CAPTCHA on step 3/);
  assert.match(ledger.render(), /x you set location to Dallas/);
});

test("a user edit is reported as a change, and attributed", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.recordUserChange("location", "Dallas");
  assert.match(ledger.render(), /^CHANGED {3}location -> Dallas \(by the user\)$/m);
});

test("a second edit to the same field replaces the first", () => {
  // The model needs the current value of `location`, not the sequence of values
  // it has had, so the older change stops being reported.
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.recordUserChange("location", "Dallas");
  ledger.recordUserChange("location", "Austin");
  assert.equal(ledger.changes.length, 1);
  assert.match(ledger.render(), /location -> Austin/);
  assert.doesNotMatch(ledger.render(), /Dallas/);
});

test("a cleared field says so rather than rendering as empty", () => {
  const ledger = new TaskLedger();
  ledger.recordUserChange("middle name", undefined);
  assert.match(ledger.render(), /middle name -> \(cleared\)/);
});

test("adopting a user edit puts it in DONE as well as CHANGED", () => {
  /*
   * Both lines carry weight and they are not the same fact. CHANGED tells the
   * model what is different from what it last saw; DONE tells it not to do the
   * work again. Without the DONE half, a model that had planned to fill the
   * location field would overwrite the user's answer.
   */
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.recordUserChange("location", "Dallas");
  ledger.adoptUserChanges();
  const rendered = ledger.render();
  assert.match(rendered, /DONE {6}x you set location to Dallas/);
  assert.match(rendered, /CHANGED {3}location -> Dallas/);
});

test("a new goal is a new task, so the old DONE list does not survive", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply to AI Engineer");
  ledger.complete("opened job");
  ledger.setCurrent("contact");
  ledger.recordUserChange("location", "Dallas");

  ledger.setGoal("Apply to Platform Engineer");
  const rendered = ledger.render();
  assert.match(rendered, /GOAL {6}Apply to Platform Engineer/);
  assert.doesNotMatch(rendered, /opened job/, "finished work from the previous task is not this task's work");
  assert.doesNotMatch(rendered, /CURRENT/);
  assert.doesNotMatch(rendered, /location/, "and neither are the previous task's user edits");
});

test("setting the same goal twice does not wipe progress", () => {
  // The reset is keyed on a *changed* goal. Re-asserting the current one is how
  // a caller would make it idempotent, and it must not destroy the ledger.
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  ledger.complete("opened job");
  ledger.setGoal("Apply");
  assert.match(ledger.render(), /x opened job/);
});

test("changes are bounded so a long handback session cannot grow the block", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("Apply");
  for (let i = 0; i < 9; i++) ledger.recordUserChange(`field${i}`, `value${i}`);
  assert.equal(ledger.changes.length, 5);
  assert.match(ledger.render(), /field8/, "the newest survive");
  assert.doesNotMatch(ledger.render(), /field0/, "the oldest go");
});

test("the rendered block stays small enough to ride on every observation", () => {
  /*
   * The budget this exists to protect. A ledger that costs more than the page
   * observation it accompanies has failed at its only job, so the ceiling is
   * asserted rather than assumed: twelve collapsed entries, five changes, a
   * goal and a step is roughly 400 characters.
   */
  const ledger = new TaskLedger();
  ledger.setGoal("Apply to the AI Engineer role at Example Corp");
  for (let i = 0; i < LEDGER_MAX_DONE; i++) ledger.complete(`finished step number ${i} of the application`);
  ledger.setCurrent("demographics");
  ledger.setNext("review");
  ledger.addBlocker("the CAPTCHA will not solve");
  for (let i = 0; i < 5; i++) ledger.recordUserChange(`field number ${i}`, `a reasonably long value ${i}`);
  const rendered = ledger.render();
  assert.ok(rendered.length <= LEDGER_MAX_CHARS, `the ledger must stay inside its budget, was ${rendered.length} chars`);
});

test("a verbose ledger is trimmed to the budget by dropping the oldest entries", () => {
  /*
   * The entry cap alone is not a budget, which this test exists because the
   * first version of the ledger got wrong: twelve entries of forty characters
   * is four times twelve entries of ten, and how long an entry is depends on
   * what the caller wrote. Realistic phrasing renders around 300 characters;
   * this is the verbose end, and it has to be trimmed rather than trusted.
   */
  const ledger = new TaskLedger();
  ledger.setGoal("Apply to the AI Engineer role at Example Corp, remote, Dallas TX");
  for (let i = 0; i < LEDGER_MAX_DONE; i++) {
    ledger.complete(`completed an extremely detailed step number ${i} involving several sub-actions`);
  }
  const rendered = ledger.render();
  assert.ok(rendered.length <= LEDGER_MAX_CHARS, `was ${rendered.length} chars`);
  assert.match(rendered, /step number 11/, "the newest work is what survives");
  assert.doesNotMatch(rendered, /step number 0\b/, "the oldest goes first");
  // The goal is never trimmed: it is the one line the whole block is read for.
  assert.match(rendered, /^GOAL {6}Apply to the AI Engineer role/);
});

test("trimming is idempotent, so rendering twice cannot shrink the ledger twice", () => {
  const ledger = new TaskLedger();
  ledger.setGoal("long");
  for (let i = 0; i < LEDGER_MAX_DONE; i++) ledger.complete(`a fairly long description of step ${i}`);
  const first = ledger.render();
  const second = ledger.render();
  assert.equal(first, second);
  assert.equal(ledger.snapshot().done.length, ledger.snapshot().done.length);
});
