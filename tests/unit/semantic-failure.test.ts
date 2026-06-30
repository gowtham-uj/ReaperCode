import test from "node:test";
import assert from "node:assert/strict";

import { detectSemanticFailureText } from "../../src/verify/semantic-failure.js";

test("semantic failure detects contradictory labeled numeric counts", () => {
  const signal = detectSemanticFailureText(
    [
      "Found 285 stack traces",
      "Number of unique call sites (based on top 3 frames): 2503",
      "Total stack traces analyzed: 7406",
    ].join("\n"),
  );

  assert.equal(signal?.reason, "numeric count mismatch output");
  assert.match(signal?.line ?? "", /Found 285 stack traces/);
});

test("semantic failure allows internally consistent labeled counts", () => {
  const signal = detectSemanticFailureText(
    [
      "Found 646 stack traces",
      "Number of unique call sites (based on top 3 frames): 317",
      "Total stack traces analyzed: 646",
      "",
      "Most common call sites:",
    ].join("\n"),
  );

  assert.equal(signal, undefined);
});

test("semantic failure detects degenerate single-bucket distributions", () => {
  const signal = detectSemanticFailureText(
    [
      "Found 285 records",
      "Number of unique buckets: 1",
      "Total records analyzed: 285",
      "",
      "Most common buckets:",
      "",
      "1. Count: 285",
      "  Frame 1: handler()",
    ].join("\n"),
  );

  assert.equal(signal?.reason, "numeric count mismatch output");
});

test("semantic failure detects raw frame prefixes and malformed structured indentation", () => {
  assert.equal(
    detectSemanticFailureText("1. Count: 55\n  Frame 1: in printStack()")?.reason,
    "artifact formatting mismatch output",
  );
  assert.equal(
    detectSemanticFailureText("1. Count: 55\n  Frame 1: printStack()")?.reason,
    "artifact formatting mismatch output",
  );
  assert.equal(detectSemanticFailureText("1. Count: 55\n   Frame 1: printStack()"), undefined);
});
