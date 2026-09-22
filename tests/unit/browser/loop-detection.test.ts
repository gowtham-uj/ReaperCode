/**
 * Telling an agent it is going in circles.
 *
 * Measured on a live mission: the agent re-ran the same click-then-wait pair
 * thirteen consecutive times, each time writing "maybe it was transient", then
 * re-ran the whole login-and-controls flow five more times. Every retry was
 * reasonable in isolation, and nothing ever told it that the last one had been
 * identical, so there was no signal to stop on.
 *
 * The rule is the one a person would apply: warn on the third repetition of the
 * same program producing the same result, not the second (a retry after a
 * transient failure is reasonable) and not the tenth (the budget is already
 * gone).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ThreadBrowserRuntime } from "../../../src/browser/thread-runtime.js";

/** A runtime with no browser, which is all this behaviour needs. */
function runtime(): ThreadBrowserRuntime {
  return new ThreadBrowserRuntime({
    threadId: "00000000-0000-0000-0000-000000000001",
    cdpUrl: "ws://127.0.0.1:1",
    cdpTimeoutMs: 200,
  });
}

const PROGRAM = 'await page.locator("#input-example button").click(); return { ok: true };';

test("no warning for the first two identical runs", () => {
  // A retry after a failure is reasonable, and warning on it would train the
  // model to ignore the warning.
  const rt = runtime();
  assert.equal(rt.noteStepOutcome(PROGRAM, "NO_CHANGE"), undefined);
  assert.equal(rt.noteStepOutcome(PROGRAM, "NO_CHANGE"), undefined);
});

test("the third identical run is named as a loop", () => {
  const rt = runtime();
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  const warning = rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  assert.ok(warning !== undefined, "the third repetition warns");
  assert.match(warning!, /LOOP/);
  assert.match(warning!, /3rd time/, "it says how many times");
  assert.match(warning!, /probeInput\(\)/, "and names a way out");
  assert.match(warning!, /recover\(\)/);
});

test("reformatting the same program is still the same program", () => {
  // A model that reflows its own code has not tried anything new, and treating
  // whitespace as a change would make the check trivially escapable.
  const rt = runtime();
  const reformatted = PROGRAM.replace(/; /g, ";\n  ").replace(/ {2,}/g, " ");
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  rt.noteStepOutcome(reformatted, "NO_CHANGE");
  assert.ok(rt.noteStepOutcome(PROGRAM, "NO_CHANGE") !== undefined, "whitespace does not reset the count");
});

test("a different result is a different history", () => {
  /*
   * The same click that failed and the same click that worked are not the same
   * loop. Counting them together would warn about a page that is making progress.
   */
  const rt = runtime();
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  rt.noteStepOutcome(PROGRAM, "SUCCESS");
  assert.equal(rt.noteStepOutcome(PROGRAM, "NO_CHANGE"), undefined, "two failures and a success is not three failures");
});

test("changing the program resets the count", () => {
  const rt = runtime();
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  const changed = PROGRAM.replace("#input-example", "#checkbox-example");
  assert.equal(rt.noteStepOutcome(changed, "NO_CHANGE"), undefined, "a different locator is a different attempt");
});

test("it warns again at six, so a long loop is not silently tolerated", () => {
  const rt = runtime();
  const seen: Array<string | undefined> = [];
  for (let i = 0; i < 6; i++) seen.push(rt.noteStepOutcome(PROGRAM, "NO_CHANGE"));
  assert.equal(seen.filter((entry) => entry !== undefined).length, 2, "warns at the third and again at the sixth, not every time");
});

test("it keeps warning past eight, instead of going silent on the ninth", () => {
  /*
   * The bug this pins: the repetition count came from a buffer of the last eight
   * steps, so it stopped at eight, the every-third gate fired at three and six
   * and then never again, and the detector went permanently quiet.
   *
   * Eight identical attempts is when a model is *most* stuck, so silence there is
   * backwards. The buffer still finds a cycle, but the warning is driven by the
   * unbounded run of identical outcomes, so it fires at nine, twelve and every
   * third attempt after that.
   */
  const rt = runtime();
  const warnings: Array<string | undefined> = [];
  for (let i = 0; i < 12; i++) warnings.push(rt.noteStepOutcome(PROGRAM, "NO_CHANGE"));
  const spoken = warnings.filter((entry) => entry !== undefined) as string[];
  assert.equal(spoken.length, 4, "the third, sixth, ninth and twelfth attempts warn");
  assert.match(spoken[3]!, /12th time/, "and the count keeps climbing rather than sticking at six");
  const quietTail = warnings.slice(7).filter((entry) => entry === undefined).length;
  assert.ok(quietTail < 5, "the tail is not silent");
});

test("the count is the number of attempts, not the size of the buffer", () => {
  const rt = runtime();
  let last: string | undefined;
  for (let i = 0; i < 9; i++) last = rt.noteStepOutcome(PROGRAM, "NO_CHANGE");
  assert.ok(last !== undefined, "the ninth attempt still warns");
  assert.match(last!, /9th time/);
});
