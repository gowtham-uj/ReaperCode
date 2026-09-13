/**
 * The two pieces of transcript chrome more than one view needs.
 *
 * They live apart from `Transcript.tsx` only because `CodeModeView` needs them
 * and `Transcript` imports `CodeModeView` — putting them in the parent would
 * close a cycle for the sake of four lines. Everything else about how a tool
 * row looks is decided by CSS, not by shared components.
 */

/**
 * The state of a tool call, as a glyph.
 *
 * A glyph and not a colour: the same information has to survive a colourblind
 * reader, a high-contrast theme, and a screenshot pasted into a bug report. The
 * `sr-only` text is the same fact in words, so a screen reader gets the whole
 * thing rather than a lone "✓".
 */
export function StatusGlyph({ status, exitCode }: { status: string; exitCode?: number }) {
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  return (
    <span className="tool-status" data-status={failed ? "failed" : status}>
      {failed ? "✕" : status === "completed" ? "✓" : "⋯"}
      <span className="sr-only">
        {failed
          ? `failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ""}`
          : status === "completed" ? "succeeded" : "running"}
      </span>
    </span>
  );
}

/**
 * Durations, in the unit a person actually thinks in at that scale.
 *
 * Milliseconds below a second because that is where the difference between two
 * fast calls is legible; seconds below a minute because "3.4s" answers "was
 * that slow" and "3400ms" makes you do arithmetic; minutes and seconds beyond
 * that because at that point the reader wants to know how long to wait.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
