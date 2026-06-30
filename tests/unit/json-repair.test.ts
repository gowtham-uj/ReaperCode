import test from "node:test";
import assert from "node:assert/strict";
import { repairTruncatedJson } from "../../src/model/json-response.js";

test("repairTruncatedJson closes truncated mid-string", () => {
  const input = '{"steps":[{"id":"a","title":"hello"}';
  const out = repairTruncatedJson(input);
  // Close the truncated string and brace — should be parseable.
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.steps[0], { id: "a", title: "hello" });
});

test("repairTruncatedJson drops a partial array element when previous ones are complete", () => {
  // Two complete step objects followed by a third truncated mid-string.
  // The fix should drop the partial step and keep the first two.
  const input = JSON.stringify({
    steps: [
      { id: "a", title: "first" },
      { id: "b", title: "second" },
      { id: "c", title: "third with truncation" },
    ],
  });
  // Simulate truncation by chopping the closing braces + the last array
  // element's value.
  const truncated = input.slice(0, input.indexOf('"third with'));
  const out = repairTruncatedJson(truncated);
  const parsed = JSON.parse(out);
  assert.equal(parsed.steps.length, 2);
  assert.deepEqual(parsed.steps[0], { id: "a", title: "first" });
  assert.deepEqual(parsed.steps[1], { id: "b", title: "second" });
});

test("repairTruncatedJson handles the live-truncation case from run 06-10-16", () => {
  // This is the exact shape of the truncated planner response we observed
  // in the live eval log.
  const truncated = [
    '{"installs":[],"steps":[',
    '{"id":"scaffold","title":"Scaffold","instructions":"create dirs"},',
    '{"id":"db","title":"DB","instructions":"schema",',
  ].join("");
  const out = repairTruncatedJson(truncated);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.installs, []);
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].id, "scaffold");
});

test("repairTruncatedJson preserves complete objects nested inside arrays", () => {
  const input = '{"steps":[{"id":"a","meta":{"k":"v"}},{"id":"b","meta":{"k2":"v2';
  const out = repairTruncatedJson(input);
  const parsed = JSON.parse(out);
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].id, "a");
  assert.equal(parsed.steps[0].meta.k, "v");
});

test("repairTruncatedJson is idempotent on well-formed input", () => {
  const input = '{"steps":[{"id":"a","title":"t"}]}';
  const out = repairTruncatedJson(input);
  assert.deepEqual(JSON.parse(out), JSON.parse(input));
});