/**
 * The form's diagnostics, and the values a server will accept.
 *
 * `inspectForm` is the call that answers "what does this field want" without
 * filling it and finding out. The half worth pinning is the case a client cannot
 * diagnose: `validity` is clean, the form looks fine, and the server still
 * refuses. That is what `probeValues` is for, and it was reachable from nothing
 * until these values were printed beside the constraints they are derived from.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeValues, renderFormDiagnostics } from "../../../../src/browser/runtime/form-diagnostics.js";

test("a constrained field carries the values to try, right where the limit is", () => {
  const rendered = renderFormDiagnostics({
    fields: [
      { name: "username", type: "text", required: true, valid: true, valueLength: 0, minLength: 4, maxLength: 16, validity: {} },
    ],
    invalid: [],
  });
  assert.match(rendered, /min 4/, "the constraint is reported");
  assert.match(rendered, /max 16/);
  assert.match(rendered, /try these/, "and the values to try are offered where the model is already looking");
});

test("nothing extra is printed for a form with no length limit", () => {
  /*
   * The block is a suggestion about a *length* policy, so a form without one gets
   * nothing. Printing boilerplate on every clean form would be the token cost
   * this whole area exists to remove, paid on every inspection.
   */
  const rendered = renderFormDiagnostics({
    fields: [{ name: "notes", type: "textarea", required: false, valid: true, valueLength: 0, validity: {} }],
    invalid: [],
  });
  assert.doesNotMatch(rendered, /try these/);
});

test("an invalid form is not handed alternatives, because it has a stated reason", () => {
  /*
   * The two situations are different and the response is different. An invalid
   * field has a message the page is willing to give, and the model should act on
   * that rather than trying lengths at random.
   */
  const rendered = renderFormDiagnostics({
    fields: [
      {
        name: "email", type: "email", required: true, valid: false, valueLength: 6,
        maxLength: 40, validity: { typeMismatch: true }, validationMessage: "Please include an '@'",
      },
    ],
    invalid: ["email"],
  });
  assert.match(rendered, /INVALID/, "the reason is reported");
  assert.match(rendered, /Please include an '@'/);
  assert.doesNotMatch(rendered, /try these/, "a stated reason beats guessing at lengths");
});

test("the produced values satisfy the length they are named for", () => {
  /*
   * They step through the thresholds that actually appear in username and
   * password policies rather than being random, and each one is the length it
   * claims to be: a value that overflows the field's own limit would be rejected
   * by the browser before the server ever saw it.
   */
  const values = probeValues("user name!");
  assert.equal(values.length, 3);
  for (const [index, length] of [8, 16, 24].entries()) {
    assert.equal(values[index]!.length, length, `value ${index} must be ${length} characters`);
    assert.match(values[index]!, /^[a-zA-Z0-9]+$/, "and contain only characters a policy will accept");
  }
});
