/**
 * Corpus-driven regression test for the verify failure classifier.
 *
 * Reads `tests/eval/fixtures/verify-failure-corpus.json` (a curated
 * list of real stderr/stdout pairs and the VerificationFailureClass
 * we expect them to produce) and asserts `classifyVerificationOutput`
 * returns the expected class for each pair.
 *
 * Two guard rails this corpus enforces:
 *   1. Every failure class the classifier can produce is covered by
 *      at least one corpus entry (catches "added a new class but
 *      forgot to add corpus coverage").
 *   2. Every corpus entry still maps to a class the classifier
 *      actually returns (catches rule deletion regressions).
 *
 * Adding a new rule to the classifier without updating this corpus
 * will fail CI; that's the point.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { classifyVerificationOutput } from "../../src/verify/failure-classifier.js";
import type { VerificationFailureClass } from "../../src/verify/failure-classifier.js";

interface CorpusEntry {
  id: string;
  description: string;
  input: { stderr: string; stdout: string };
  expectedClass: VerificationFailureClass;
  strategyContains: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(here, "fixtures", "verify-failure-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusEntry[];

test("verify-failure-classifier corpus covers every documented class", () => {
  // Every class the classifier can produce must have at least one
  // corpus entry. This guards against "added a class but forgot to
  // add corpus coverage" regressions.
  const documentedClasses: VerificationFailureClass[] = [
    "missing_script",
    "missing_artifact",
    "missing_dependency",
    "missing_type_dependency",
    "permission_or_executable",
    "text_encoding_or_binary_output",
    "test_discovery",
    "typecheck",
    "compile_error",
    "build_config",
    "runtime_exception",
    "assertion_failure",
    "exact_output_mismatch",
    "external_service",
    "environment_missing",
    "performance_regression",
    "timeout",
    "dependency_install",
    "schema_or_migration",
    "unknown",
  ];
  const covered = new Set(corpus.map((entry) => entry.expectedClass));
  const uncovered = documentedClasses.filter((cls) => !covered.has(cls));
  assert.deepEqual(
    uncovered,
    [],
    `Corpus does not cover these documented classes: ${uncovered.join(", ")}. Add a fixture under tests/eval/fixtures/verify-failure-corpus.json for each.`,
  );
});

for (const entry of corpus) {
  test(`verify-failure-classifier classifies '${entry.id}' as ${entry.expectedClass}`, () => {
    const combinedOutput = [entry.input.stderr, entry.input.stdout]
      .filter(Boolean)
      .join("\n");
    const result = classifyVerificationOutput(combinedOutput);
    assert.ok(
      result.classes.includes(entry.expectedClass),
      `Expected class '${entry.expectedClass}' in result for fixture '${entry.id}' (${entry.description}). Got: [${result.classes.join(", ")}]`,
    );
  });
}
