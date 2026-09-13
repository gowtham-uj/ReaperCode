/**
 * The two pieces of transcript chrome more than one view needs.
 *
 * They live apart from `Transcript.tsx` only because `CodeModeView` needs them
 * and `Transcript` imports `CodeModeView` — putting them in the parent would
 * close a cycle for the sake of four lines. Everything else about how a tool
 * row looks is decided by CSS, not by shared components.
 */

/**
 * The state of a tool call.
 *
 * Shape carries the fact, not colour: the same information has to survive a
 * colourblind reader, a high-contrast theme, and a screenshot pasted into a bug
 * report. `sr-only` text is the same fact in words, so a screen reader gets the
 * whole thing rather than a lone "✓".
 *
 * The running state is a spinner rather than the "⋯" it used to be. A static
 * ellipsis is indistinguishable from a glyph that failed to render, and it does
 * not move — so a tool call that had been running for two minutes looked
 * exactly like one that had finished, which is the report this addresses.
 * Motion is the one signal that reads as "still happening" without a legend,
 * and it is what the reference interface uses.
 */
export function StatusGlyph({ status, exitCode }: { status: string; exitCode?: number }) {
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const running = !failed && status !== "completed";
  return (
    <span className="tool-status" data-status={failed ? "failed" : running ? "inProgress" : "completed"}>
      {failed ? "✕" : running ? (
        /*
         * An SVG arc, not a border-radius trick, so the stroke width and the
         * gap stay crisp at 13px and the dash can be animated directly. The
         * `aria-hidden` is deliberate: the `sr-only` span below is what carries
         * the state, and announcing the spinner as an image would duplicate it.
         */
        <svg className="tool-spinner" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        "✓"
      )}
      <span className="sr-only">
        {failed
          ? `failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ""}`
          : running ? "running" : "succeeded"}
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
