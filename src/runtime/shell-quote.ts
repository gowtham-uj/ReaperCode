/**
 * Shell argument quoting — single source of truth.
 *
 * Used by:
 *   - src/runtime/engine.ts:10722
 *   - src/tools/global/bash.ts:588
 *   - src/tools/global/bash.ts:1174 (printf-style)
 *   - src/verify/runner.ts:268
 *   - src/tools/executor.ts:1884
 *
 * The previous per-file implementation `'${value.replace(/'/g, "'\\''")}'`
 * did NOT escape embedded newlines. A command arg like `foo\nrm -rf /`
 * would be split into two shell statements by the parser, with the
 * second one unquoted. This file is the single replacement: any caller
 * should import `shellQuote` from here, never define its own.
 *
 * The fix: replace any `\r` or `\n` with a space BEFORE applying
 * single-quote escaping. The resulting string is still safe to drop
 * inside a `'...'` pair.
 */

export function shellQuote(value: string): string {
  // Newlines are the main injection vector. A backtick, $, and " would
  // also be exploitable INSIDE a `'` block only via `'\''`-escaping,
  // which the previous implementation already handled. The new
  // addition is the whitespace normalization.
  const sanitized = value.replace(/[\r\n]+/g, " ");
  return `'${sanitized.replace(/'/g, "'\\''")}'`;
}

/**
 * Variant for embedding inside a `printf` template (no surrounding
 * quotes are added — the caller controls them). Same newline
 * normalization.
 */
export function shellSingleQuoteForPrintf(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/'/g, "'\\''");
}
