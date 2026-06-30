import test from "node:test";
import assert from "node:assert/strict";

import { classifyVerificationFailure, shouldPromoteNonDeterministicFailure } from "../../src/verify/classifier.js";

test("classifies assertion-style failures as deterministic", () => {
  assert.equal(classifyVerificationFailure("Expected 42 but got 41"), "deterministic");
});

test("classifies environment noise as non-deterministic", () => {
  assert.equal(classifyVerificationFailure("Error: EADDRINUSE: address already in use"), "non_deterministic");
  assert.equal(classifyVerificationFailure("Process timed out after 30000ms"), "non_deterministic");
});

test("promotes repeated non-deterministic failures after threshold", () => {
  assert.equal(shouldPromoteNonDeterministicFailure(["non_deterministic", "non_deterministic"]), false);
  assert.equal(shouldPromoteNonDeterministicFailure(["non_deterministic", "non_deterministic", "non_deterministic"]), true);
});
