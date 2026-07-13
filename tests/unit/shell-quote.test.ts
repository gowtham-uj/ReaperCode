/**
 * Unit tests for src/runtime/shell-quote.ts.
 *
 * The 4 call sites (engine.ts, global/bash.ts x2, verify/runner.ts,
 * tools/executor.ts) all delegate to this module. These tests pin the
 * contract: an arg with embedded newlines MUST NOT split into multiple
 * shell statements.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { shellQuote, shellSingleQuoteForPrintf } from "../../src/runtime/shell-quote.js";

test("shellQuote wraps a simple string in single quotes", () => {
  assert.equal(shellQuote("foo"), "'foo'");
});

test("shellQuote escapes a literal single quote", () => {
  // "don't" → 'don'\''t'
  assert.equal(shellQuote("don't"), "'don'\\''t'");
});

test("shellQuote replaces embedded newlines with a space (injection block)", () => {
  // The key fix: a command arg containing a newline must not split
  // into two shell statements.
  assert.equal(shellQuote("foo\nrm -rf /"), "'foo rm -rf /'");
});

test("shellQuote replaces embedded carriage returns too", () => {
  assert.equal(shellQuote("foo\r\nbar"), "'foo bar'");
});

test("shellQuote collapses multiple newlines", () => {
  assert.equal(shellQuote("a\n\n\nb"), "'a b'");
});

test("shellQuote handles an empty string", () => {
  assert.equal(shellQuote(""), "''");
});

test("shellQuote handles whitespace-only strings", () => {
  assert.equal(shellQuote("   "), "'   '");
});

test("shellQuote preserves $ and backticks (single quotes are literal in sh)", () => {
  // Inside '...' the shell does NOT interpolate, so $VAR and `cmd`
  // are literal text. This is a property of sh, not of this function.
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`rm -rf /`"), "'`rm -rf /`'");
});

test("shellQuote handles the newlines + quotes combo (real attack)", () => {
  // The realistic attack string from the audit. The previous
  // implementation returned "'foo'\nrm -rf /'" which the shell
  // parses as two statements.
  const input = "foo'\nrm -rf /";
  const out = shellQuote(input);
  // No literal newline should survive.
  assert.equal(out.includes("\n"), false, `output must not contain a newline, got: ${JSON.stringify(out)}`);
  // Should still be a balanced single-quoted string.
  assert.match(out, /^'.*'$/);
});

test("shellSingleQuoteForPrintf does NOT add surrounding quotes", () => {
  // This is the printf-embedding variant. The caller's template
  // supplies the surrounding context.
  assert.equal(shellSingleQuoteForPrintf("foo"), "foo");
  assert.equal(shellSingleQuoteForPrintf("don't"), "don'\\''t");
});

test("shellSingleQuoteForPrintf replaces newlines with a space", () => {
  assert.equal(shellSingleQuoteForPrintf("a\nb"), "a b");
});
