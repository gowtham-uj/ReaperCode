import test from "node:test";
import assert from "node:assert/strict";

import { extractLocalizationHints, formatLocalizationHintsForFeedback } from "../../src/localization/from_tests.js";
import { classifyVerificationOutput } from "../../src/verify/failure-classifier.js";

test("extracts Python traceback file, line, and function hints", () => {
  const hints = extractLocalizationHints('  File "src/app.py", line 42, in solve\n    raise ValueError("bad")\n');

  assert.equal(hints[0]?.path, "src/app.py");
  assert.equal(hints[0]?.line, 42);
  assert.equal(hints[0]?.symbol, "solve");
  assert.equal(hints[0]?.contextStart, 22);
  assert.equal(hints[0]?.contextEnd, 62);
});

test("extracts JavaScript stack frame hints", () => {
  const hints = extractLocalizationHints("at renderTask (src/ui/App.tsx:17:9)\n");

  assert.equal(hints[0]?.path, "src/ui/App.tsx");
  assert.equal(hints[0]?.line, 17);
  assert.equal(hints[0]?.column, 9);
  assert.equal(hints[0]?.symbol, "renderTask");
});

test("extracts TypeScript compiler diagnostic hints", () => {
  const hints = extractLocalizationHints("src/index.ts(5,12): error TS2322: Type 'number' is not assignable\n");

  assert.equal(hints[0]?.path, "src/index.ts");
  assert.equal(hints[0]?.line, 5);
  assert.equal(hints[0]?.column, 12);
});

test("formats localization hints as bounded view_file guidance", () => {
  const feedback = formatLocalizationHintsForFeedback(extractLocalizationHints("tests/test_app.py:12: AssertionError\n"));

  assert.match(feedback[0] ?? "", /Use view_file/);
  assert.match(feedback[0] ?? "", /startLine=1/);
});

test("verification classifier prepends localization feedback facts", () => {
  const classified = classifyVerificationOutput("src/app.ts(9,4): error TS1005: ';' expected\n");

  assert.match(classified.facts[0] ?? "", /Localization hint/);
  assert.match(classified.facts[0] ?? "", /src\/app\.ts/);
});
