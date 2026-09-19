import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FIXED_SLEEP_THRESHOLD_MS,
  findFixedSleeps,
  resolveBudget,
  WAIT_BUDGETS,
} from "../../../../src/browser/runtime/wait-policy.js";

test("no budget inherits Playwright's thirty-second default", () => {
  /*
   * The measured cost of the default was eleven minutes of failed browser calls
   * in one mission. The assertion is about the shape rather than the numbers: a
   * budget at or above the default would mean the policy had changed nothing for
   * that operation.
   */
  for (const [kind, ms] of Object.entries(WAIT_BUDGETS)) {
    assert.ok(ms < 30_000, `${kind} is ${ms}ms, which is not shorter than the default it replaces`);
    assert.ok(ms > 0, `${kind} must be a positive budget`);
  }
});

test("a locator action is budgeted far below a navigation", () => {
  assert.ok(WAIT_BUDGETS.locator < WAIT_BUDGETS.navigation);
  assert.ok(WAIT_BUDGETS.locator < WAIT_BUDGETS.slowAjax);
});

test("a named budget resolves, and an unknown name falls back rather than throwing", () => {
  assert.equal(resolveBudget("navigation", "locator"), WAIT_BUDGETS.navigation);
  assert.equal(resolveBudget("nonsense", "locator"), WAIT_BUDGETS.locator);
  assert.equal(resolveBudget(undefined, "assertion"), WAIT_BUDGETS.assertion);
  assert.equal(resolveBudget(1_234, "locator"), 1_234);
});

test("a long fixed sleep is reported with what to wait for instead", () => {
  const warnings = findFixedSleeps("await page.waitForTimeout(3000);\nawait page.click('a');");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.ms, 3000);
  assert.match(warnings[0]?.instead ?? "", /waitForURL|toBeVisible|waitForChange/);
});

test("a short sleep is left alone, because debounce and animation are real", () => {
  /*
   * A check that flags every sleep is a check the model learns to ignore, which
   * costs the warnings that matter. Sub-threshold waits are legitimate and this
   * asserts they stay quiet.
   */
  const warnings = findFixedSleeps("await page.waitForTimeout(50);");
  assert.deepEqual(warnings, []);
  assert.ok(FIXED_SLEEP_THRESHOLD_MS > 50);
});

test("the sleep spelling a model reaches for second is caught too", () => {
  assert.equal(findFixedSleeps("await sleep(2000)").length, 1);
});
