/**
 * Assertions against a thrown Zod error.
 *
 * The suite used to assert on Zod's *message strings* — `/Invalid enum value/`,
 * `/String must contain at least 1 character/`, `/Invalid datetime/`. Those
 * strings are prose, Zod rewrote them in v4, and every one of those assertions
 * broke at once on the upgrade while the validation behaviour underneath was
 * unchanged. Prose is a bad contract to test against.
 *
 * The issue `code` is the contract. `invalid_value`, `too_small`,
 * `invalid_format`, `unrecognized_keys` are stable identifiers that survive
 * rewordings, and `path` pins down *which* field was rejected — which is the
 * thing the test actually cares about and which a message regex only ever
 * implied. Both are checked here, so the assertions got stronger as they got
 * less brittle.
 */

import assert from "node:assert/strict";

interface ZodIssueLike {
  code: string;
  path: PropertyKey[];
  message?: string;
  format?: string;
}

/** The shape a thrown `ZodError` exposes, without importing Zod's types. */
interface ZodErrorLike {
  issues: ZodIssueLike[];
}

function issuesOf(error: unknown): ZodIssueLike[] {
  const issues = (error as ZodErrorLike | undefined)?.issues;
  assert.ok(
    Array.isArray(issues),
    `expected a ZodError with an \`issues\` array, got ${String(error)}`,
  );
  return issues;
}

/**
 * Run `fn`, expect it to throw a `ZodError`, and assert that at least one
 * issue matches.
 *
 * `path` is compared as a joined string (e.g. `"tokenBudget.inputTokens"`), so
 * both the field and the reason are named in the failure message rather than
 * left for the reader to reconstruct from a dumped message.
 */
export function assertZodIssue(
  fn: () => unknown,
  expected: { code: string; path?: string; format?: string },
): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  assert.ok(caught !== undefined, `expected a ZodError for code "${expected.code}", but nothing was thrown`);

  const issues = issuesOf(caught);
  const wanted = expected.path ?? "";
  const match = issues.find(
    (issue) =>
      issue.code === expected.code &&
      (expected.path === undefined ? true : issue.path.join(".") === wanted) &&
      (expected.format === undefined ? true : issue.format === expected.format),
  );

  assert.ok(
    match,
    `no issue matched ${JSON.stringify(expected)}; got ${issues
      .map((issue) => `${issue.code} @ ${issue.path.join(".") || "(root)"}`)
      .join(", ")}`,
  );
}
