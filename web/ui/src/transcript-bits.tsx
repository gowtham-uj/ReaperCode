/**
 * The transcript chrome more than one view needs.
 *
 * They live apart from `Transcript.tsx` only because `CodeModeView` needs them
 * and `Transcript` imports `CodeModeView` — putting them in the parent would
 * close a cycle for the sake of four lines. Everything else about how a tool
 * row looks is decided by CSS, not by shared components.
 *
 * `StatusGlyph` carries the state as a shape for a screen reader and for a
 * colourblind reader. The word beside it is the transcript's own `tool-card-note`,
 * which says "Failed" or "Running…" only when there is something to say.
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
import { Fragment, useEffect, useState, type ReactNode } from "react";

import { ToolIcon, type IconName } from "./tool-icons.js";

export function StatusGlyph({ status, exitCode }: { status: string; exitCode?: number }) {
  const failed = status === "failed" || (exitCode !== undefined && exitCode !== 0);
  const running = !failed && status !== "completed";
  return (
    <span className="tool-status" data-status={failed ? "failed" : running ? "inProgress" : "completed"}>
      {failed ? "✕" : !running ? (
        /*
         * A filled disc with the tick knocked out of it, which is what the
         * reference draws and what a bare "✓" could not be. The rail is a
         * column of marks read at a glance from several rows away, and a
         * stroked tick in the same weight as the body text disappears into it;
         * a solid shape at 13px is still a solid shape in peripheral vision.
         * The colour is the success token, so it is a green disc in every
         * theme without a per-theme rule.
         */
        <svg className="tool-done" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="m4.9 8.2 2.1 2.1 4.1-4.4" fill="none" stroke="var(--dsw-alias-bg-module-platform)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
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

/**
 * The icon tile, as the reference interface draws it.
 *
 * A rounded square holding the tool's icon. It gives the eye a fixed column to
 * run down, which is what makes a long transcript scannable, and it survives
 * the one case a bare text prefix does not: a file edit and a shell command
 * look the same at a glance once the labels are the same width.
 *
 * `tone` is what separates the reference's two tiers. A light action gets a
 * transparent tile and the icon in caption grey — the reference draws its
 * search and read rows that way, as icons on the background rather than as
 * chips. An action that changed something gets a filled accent tile, which is
 * why the "Updated" and "Run tests" rows are the two things the eye lands on in
 * a screen of twenty rows.
 */
export function ToolIconTile({ icon, tone }: { icon: IconName; tone?: "plain" | "accent" | "success" | "failed" | undefined }) {
  return (
    <span className="tool-tile" data-tone={tone ?? "plain"} aria-hidden="true">
      <ToolIcon name={icon} size={14} />
    </span>
  );
}

/**
 * How many lines of tool output reach the DOM before the rest is held back.
 *
 * A build log is routinely tens of thousands of lines, and a transcript with
 * three of them in it becomes a page the browser struggles to lay out and a
 * reader cannot scroll past. The tail rather than the head, because the end of
 * a log is where the failure is; the earlier lines are one click away.
 */
const OUTPUT_HEAD_LINES = 40;

/**
 * Long output, tail-first, with the rest behind a click.
 *
 * The count is stated rather than implied ("Showing the last 40 of 1,482
 * lines"), because silently truncating output is how a reader ends up trusting
 * a partial log. Expanding renders the whole thing — at that point they have
 * asked for it, and the cost is theirs to pay.
 */
export function ToolOutput({ text, command, terminal = true }: { text: string; command?: string; terminal?: boolean }) {
  const lines = text ? text.split("\n") : [];
  const [full, setFull] = useState(false);
  const long = lines.length > OUTPUT_HEAD_LINES;
  const shown = full || !long ? text : lines.slice(-OUTPUT_HEAD_LINES).join("\n");
  /*
   * The tail is the right default and it is not always enough. A failing build
   * prints its error and then keeps going for another two hundred lines of
   * progress, so the last forty are the tidy end of a run that went wrong five
   * screens earlier — the tail was showing "transforming (1462)" while the
   * message the reader needed sat at line 1301, invisible and unmentioned.
   *
   * So when a line above the window looks like the failure, name it. One line,
   * the first match, not a parsed diagnosis: the claim is only "this is in the
   * part we hid", which is true and checkable, and clicking through shows the
   * whole log.
   */
  const buried = long && !full ? findError(lines.slice(0, -OUTPUT_HEAD_LINES)) : undefined;
  return (
    <>
      {long && (
        <button className="tool-more" onClick={() => setFull((value) => !value)} aria-expanded={full}>
          {full
            ? `Showing all ${lines.length.toLocaleString()} lines`
            : `Showing the last ${OUTPUT_HEAD_LINES} of ${lines.length.toLocaleString()} lines`}
        </button>
      )}
      {buried && (
        <p className="tool-buried">
          <span className="tool-buried-label">Earlier, at line {buried.line.toLocaleString()}</span>
          <code>{buried.text}</code>
        </p>
      )}
      <pre className="tool-output" data-terminal={terminal || undefined}>
        {/*
          The prompt line, when there is a command to echo.

          A `>` and the command, exactly as the reference draws it and exactly
          as a terminal does. It is not decoration: it is what makes the block
          below it self-evidently the result of *that* command, which matters
          most in the case where the head row truncated it.
        */}
        {command !== undefined && <span className="tool-output-cmd">{`> ${command}\n`}</span>}
        {/*
          The elision, drawn where the cut happened.

          Without it the block reads as the whole log, and the count above the
          terminal is the only thing saying otherwise — a line of text a reader
          skims past on their way to the output. The reference puts "..." in the
          stream itself, which is both how a terminal pager shows a gap and the
          only place a reader is guaranteed to be looking.
        */}
        {long && !full && <span className="tool-output-gap">{"⋯\n"}</span>}
        {colourTerminal(shown)}
      </pre>
    </>
  );
}

/**
 * Test-runner lines, tinted.
 *
 * A terminal block is grey by design and should stay that way; the exception is
 * the two or three lines a reader is actually looking for, which every runner
 * prints in roughly the same shape — a tick, a cross, "18 passing", "1 failed".
 * The reference colours exactly those and nothing else, and that is what turns a
 * twenty-line block into something answerable at a glance.
 *
 * Line-level, not token-level: a whole-line class is cheap and cannot mis-tint
 * half a sentence. Anything unrecognised stays the body colour, which is the
 * right default for output this code does not understand.
 */
const PASS_LINE = /^\s*(?:✓|✔|PASS\b|ok\b)|(?:^|\s)(?:\d+\s+(?:passing|passed))\b/i;
const FAIL_LINE = /^\s*(?:✕|✖|×|FAIL\b|error\b)|(?:^|\s)(?:[1-9]\d*\s+(?:failing|failed)|\d+\s+problems?)\b/i;

function colourTerminal(text: string): ReactNode {
  if (!text) return text;
  const lines = text.split("\n");
  // Nothing to say about this output, so hand back the original string and let
  // React render one text node instead of several hundred spans.
  if (!lines.some((line) => PASS_LINE.test(line) || FAIL_LINE.test(line))) return text;
  return lines.map((line, index) => {
    const nl = index < lines.length - 1 ? "\n" : "";
    const cls = FAIL_LINE.test(line) ? "fail" : PASS_LINE.test(line) ? "pass" : undefined;
    if (cls === undefined) return <Fragment key={index}>{line + nl}</Fragment>;
    return (
      <Fragment key={index}>
        <span className={`term-${cls}`}>{line}</span>
        {nl}
      </Fragment>
    );
  });
}

/**
 * The first line in the hidden part that announces itself as a failure.
 *
 * Word-boundary matching on the words tools actually print, anchored so a path
 * containing "error" does not match. Deliberately shallow: this decides which
 * line to quote, not what went wrong, and a wrong guess costs one quoted line
 * rather than a wrong diagnosis.
 */
function findError(lines: string[]): { line: number; text: string } | undefined {
  for (const [index, line] of lines.entries()) {
    if (/(^|\s)(error|ERROR|Error:|FAIL|FAILED|failed|Exception|Traceback|panic:)(\s|:|$)/.test(line)) {
      return { line: index + 1, text: line.trim().slice(0, 160) };
    }
  }
  return undefined;
}

/**
 * The raw call, for whoever needs it, never in the way of whoever does not.
 *
 * Everything above this in a tool card is an interpretation — a label chosen by
 * a mapping table, a path pulled out of the arguments, a count of matched
 * lines. When one of those is wrong, the only way to tell is to see what the
 * model actually sent, and reconstructing that from a rendered card is
 * guesswork. So: the tool's real name, the argument object as JSON, and the
 * call id, closed by default and one click away.
 *
 * A `<details>` rather than the card's own disclosure pattern, because this is
 * the one section that should never be opened by anything but a deliberate
 * click — not by a failure, not by a status change.
 */
export function RawDetails({ tool, args, callId, durationMs }: {
  tool: string;
  args?: Record<string, unknown> | undefined;
  callId?: string | undefined;
  durationMs?: number | undefined;
}) {
  return (
    <details className="tool-raw">
      <summary className="tool-raw-summary">View raw call</summary>
      <dl className="tool-raw-list">
        <dt>Tool</dt>
        <dd><code>{tool}</code></dd>
        {callId && (<><dt>Call id</dt><dd><code>{callId}</code></dd></>)}
        {durationMs !== undefined && (<><dt>Duration</dt><dd>{formatDuration(durationMs)}</dd></>)}
        {args && Object.keys(args).length > 0 && (
          <><dt>Arguments</dt><dd><pre className="tool-raw-json">{JSON.stringify(args, null, 2)}</pre></dd></>
        )}
      </dl>
    </details>
  );
}

/**
 * A labelled, boxed section inside a tool card — Input or Output.
 *
 * The reference puts these in boxes with their own disclosure rather than in
 * one expanding body: a shell command's input is one line the reader usually
 * does not need, and its output is the part they came for, so collapsing both
 * together forces a scroll past the noise to reach the substance.
 */
export function ToolSection({
  title,
  children,
  defaultOpen = true,
  mono = true,
  hint,
  trailing,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean | undefined;
  mono?: boolean | undefined;
  hint?: string | undefined;
  trailing?: ReactNode | undefined;
}) {
  const [open, setOpen] = useState(defaultOpen);
  /*
   * Re-open when `defaultOpen` becomes true, and the case that made this
   * necessary is the one this whole component exists for.
   *
   * `useState(defaultOpen)` captures the value at mount. A tool card mounts
   * while its call is still running, when the output section's `defaultOpen` is
   * false; when the call then *fails*, the section kept the stale `false` and
   * the error stayed behind a click. A failure the reader has to click to see is
   * a failure that gets missed, which is exactly what `defaultOpen={failed}`
   * was written to prevent.
   *
   * Only opening, never closing: a reader who opens a successful call's output
   * keeps it open when a later status change arrives, because collapsing
   * something the user just expanded is worse than leaving it open.
   */
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  return (
    <div className="tool-section" data-open={open || undefined}>
      <button className="tool-section-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span>
        <span className="tool-section-title">{title}</span>
        {hint && <span className="tool-section-hint">{hint}</span>}
        {trailing && <span className="tool-section-trailing">{trailing}</span>}
      </button>
      {open && <div className="tool-section-body" data-mono={mono || undefined}>{children}</div>}
    </div>
  );
}
