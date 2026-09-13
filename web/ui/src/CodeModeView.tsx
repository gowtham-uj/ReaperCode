import { useEffect, useRef, useState } from "react";
import {
  codeModeFailureText,
  readCodeModeResult,
  type AppThreadItem,
  type CodeModeLiveLine,
  type CodeModeResult,
  type CodeModeToolCall,
} from "@reaper/web-shared";

import { toolLabel } from "@reaper/web-shared";

import { formatDuration, StatusGlyph } from "./transcript-bits.js";

/*
 * Code Mode, as it reads in a transcript.
 *
 * The shape of this component is decided by what an eval call actually *is*:
 * a program the model wrote, running, calling Reaper's own tools underneath.
 * That is three things a single tool row cannot show — the source, the inner
 * calls, and the value that came back — so the row summarises and the body
 * opens into all three.
 *
 * Two rules carry most of the design.
 *
 * The first is that the intermediate data must *not* be shown. The entire
 * reason to reach for eval is that a hundred file bodies stay inside the
 * script and one small answer comes out; rendering the intermediate would
 * rebuild, in the UI, exactly the cost the model just avoided. So the inner
 * call list shows names, outcomes and durations — never outputs.
 *
 * The second is that "running" has to look like running. A script that reads
 * forty files takes a while, and the live output the runtime streams is the
 * only thing standing between a person and a blank row with a spinner. It
 * appends as it arrives, which is what makes the difference between watching
 * work happen and waiting to find out whether it did.
 */

type CodeModeItem = Extract<AppThreadItem, { type: "dynamicToolCall" }>;

export function CodeModeView({ item }: { item: CodeModeItem }) {
  const code = typeof item.arguments.code === "string" ? item.arguments.code : "";
  /*
   * Open by default when there is a script or a value worth reading.
   *
   * It started collapsed, which meant a finished eval rendered as a single thin
   * line — `{ } Code Mode  → 2  157ms ✓` — and the program the model wrote, the
   * whole point of Code Mode, was one click away from a reader who had no
   * reason to suspect it was there. A tool row collapses because its detail is
   * incidental; this one expands because its detail *is* the feature.
   *
   * Still collapsed while running (the live output has its own region below)
   * and for a script that produced nothing to show.
   */
  /*
   * A lazy initializer is not enough here, and the live UI is what showed it.
   *
   * `useState(() => …)` runs once, on mount — and a Code Mode item mounts the
   * moment its call *starts*, when there is no result yet. So the initializer
   * saw `inProgress` and chose collapsed, and the block stayed collapsed after
   * the result arrived, which is precisely the "the code is gone when it
   * finishes" complaint being re-created by the fix for it. The screenshot
   * caught it: the row read `→ 55` with a chevron pointing right.
   *
   * So the state is seeded *and* updated: it opens itself the first time there
   * is something to read, and a person who closes it keeps it closed, because
   * `touched` records that the choice was theirs.
   */
  const hasContent = item.status !== "inProgress" && (code.trim().length > 0 || item.result !== undefined);
  const [open, setOpen] = useState(hasContent);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (hasContent && !touched) setOpen(true);
  }, [hasContent, touched]);
  const result = readCodeModeResult(item.result);
  const running = item.status === "inProgress";
  const liveLines = item.liveOutput ?? [];
  const failure = codeModeFailureText(result, item.error);

  /*
   * A script that is running and has already called something is *working*, and
   * the collapsed row should say so rather than sit there blank. The count is
   * derived from the live stream rather than from a separate counter because
   * the stream is the only thing arriving during the run — and it is the truer
   * number anyway: it counts what the person can see happening.
   */
  const liveCallCount = liveLines.filter((line) => line.kind === "tool").length;

  /*
   * Whose success the glyph reports.
   *
   * A script that throws is a *successful tool call* — the runtime caught the
   * exception, serialised it, and handed it back exactly as designed, so the
   * call's own status is `completed`. Passing that status straight to the
   * glyph produced a row reading "Code Mode failed … ✓", which is both true
   * and useless: the reader does not care whether the plumbing worked, they
   * care whether the program did. So the script's verdict wins where there is
   * one, and the call's status is what remains when there isn't.
   */
  const status = failure ? "failed" : item.status;

  return (
    <div className="tool-block code-mode" data-state={running ? "running" : "settled"}>
      <button className="disclosure tool-disclosure" aria-expanded={open} onClick={() => { setTouched(true); setOpen((value) => !value); }}>
        <span className="chevron" data-open={open || undefined} aria-hidden="true">›</span>
        <span className="tool-icon code-mode-icon" aria-hidden="true">{"{ }"}</span>
        {/*
          The tool's own name, beautified — `Eval`, not "Code Mode".
          
          Code Mode is the *name of the feature*; `eval` is the name of the tool
          the model called, and the row is presenting a tool call. A reader who
          goes looking for this in a tool list, a config file, or the model's own
          transcript is looking for `eval`, and a label that says something else
          makes them translate between two vocabularies for one thing.
        */}
        <span className="tool-label">{toolLabel("eval")}</span>
        <span className="tool-detail" title={firstLine(code)}>{summarizeRun(result, running, liveCallCount, code)}</span>
        <span className="tool-meta">
          {/*
            Two durations exist and the client's is preferred. The one measured
            here includes the queue and the transport — it answers "how long did
            I wait", which is the question the row is answering. The runtime's
            own number is the fallback, because a transcript replayed from a
            journal has no client clock behind it at all.
          */}
          {!running && (item.durationMs ?? result?.durationMs) !== undefined && (
            <span className="tool-duration">{formatDuration(item.durationMs ?? result!.durationMs!)}</span>
          )}
          <StatusGlyph status={status} />
        </span>
      </button>

      {/*
        A failure is the one thing worth reading without asking for it — the
        same rule the command row follows with its output. Collapsed and silent,
        a failed script and a throwaway one look identical.
      */}
      {/*
        Shown open or closed. It used to be `!open`, on the reasoning that the
        expanded body would carry its own error — but it does not: `ResultView`
        renders console, value, and note, and a thrown script has none of the
        three. So expanding a failed block deleted the only explanation on
        screen, leaving the code, an empty body, and a ✕ in the corner. The one
        gesture a person makes to learn *more* about a failure was the gesture
        that took the failure away.
      */}
      {!running && failure && (
        <p className="code-mode-error" data-status="failed" role="alert">
          {failure}
          {/*
            The hint is the half of the error that says what to do instead, and
            it was reaching the model's context and the CLI while the web row
            showed only the complaint. Caught in a drive screenshot: a block
            reading "ReferenceError: could not load module 'node:fs'" and
            nothing else, when the runtime had already attached the sentence
            naming `tools.read`. Same failure, two surfaces, one of them
            withholding the answer.
          */}
          {result?.error?.hint && <span className="code-mode-hint">{result.error.hint}</span>}
        </p>
      )}

      {open && (
        <div className="code-mode-body">
          <CodeBlock code={code} />
          {running && liveLines.length > 0 && <LiveOutput lines={liveLines} />}
          {!running && result && result.toolCalls.length > 0 && <ToolLedger calls={result.toolCalls} />}
          {!running && result && <ResultView result={result} />}
          {/*
            The body has nothing of its own to add when there is no report.
            `item.error` already renders above as the alert — which is *why* the
            alert is shown open or closed — so repeating it here printed the
            same sentence twice, once per region, the moment the block expanded.
            A reader who clicked to learn more got the same paragraph again in a
            different typeface.
          */}
        </div>
      )}
    </div>
  );
}

function firstLine(code: string): string | undefined {
  const line = code.split("\n").find((candidate) => candidate.trim());
  return line?.trim();
}

/** The one-line answer to "what is this row". */
function summarizeRun(
  result: CodeModeResult | undefined,
  running: boolean,
  liveCallCount: number,
  code: string,
): string {
  if (running) {
    return liveCallCount > 0
      ? `running · ${liveCallCount} tool call${liveCallCount === 1 ? "" : "s"} so far`
      : "running";
  }
  if (!result) return firstLine(code) ?? "";
  const calls = result.toolCalls.length;
  const parts: string[] = [];
  if (calls > 0) parts.push(`${calls} tool call${calls === 1 ? "" : "s"}`);
  const shown = previewValue(result.value);
  /*
   * `→ 2`, not `2`.
   *
   * A returned value and a call count are both bare numbers, so a script that
   * called nothing and returned `2` produced a row reading exactly `2` — which
   * reads as "two of something" beside a column that says `2 tool calls` two
   * pixels away. The arrow is what the CLI already prints for a value (see
   * `describeEvalRun` in `src/runtime/session-printer.ts`), so the two surfaces
   * label the same fact the same way.
   */
  if (shown) parts.push(`→ ${shown}`);
  const word = statusWord(result.status);
  if (word) parts.push(word);

  /*
   * A completed script that called nothing and returned nothing has an empty
   * summary, and the row went blank — caught in a drive screenshot, where the
   * whole line read just `{ } Code Mode  207ms`.
   *
   * The interesting part is that this is not a rare shape. The live model ran
   * its work through raw `node:fs` instead of `tools.*`, so there were no inner
   * calls to count, and its last statement was a serialising call rather than a
   * bare expression, so there was no value to preview. `calls` and `value` are
   * the only two things the summary looks at, and both were legitimately empty.
   *
   * The runtime had already diagnosed it: `note` is set precisely when the
   * rewrite could not find a value to return, and it says which statement to end
   * with. That sentence belongs on the row. Falling back to the script's first
   * line is the second resort — it answers "what was this?" when nothing else
   * can, which is strictly better than an empty cell and never worse than the
   * whole row being unreadable.
   */
  if (parts.length === 0) {
    return result.note ?? firstLine(code) ?? "";
  }
  return parts.join(" · ");
}

function statusWord(status: CodeModeResult["status"]): string {
  switch (status) {
    case "timeout": return "timed out";
    case "cancelled": return "cancelled";
    case "memory": return "out of memory";
    case "tool_call_limit": return "tool-call limit reached";
    case "error": return "failed";
    default: return "";
  }
}

/**
 * A short, honest rendering of the returned value.
 *
 * Honest means it says what kind of thing came back rather than pretending to
 * show it: an array of forty records summarises as `40 items`, because a
 * truncated dump of the first three is more misleading than the count. The
 * full value is one click away.
 */
function previewValue(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 60 ? JSON.stringify(`${value.slice(0, 57)}…`) : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length <= 3 && keys.length > 0 ? `{ ${keys.join(", ")} }` : `${keys.length} keys`;
  }
  return String(value);
}

function CodeBlock({ code }: { code: string }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className="code-mode-source">
      <div className="code-mode-section-head">JavaScript</div>
      <div className="code-block" data-code>
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span className="code-gutter" aria-hidden="true">{index + 1}</span>
            <span className="code-text">{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Output that arrived while the script was still running. */
function LiveOutput({ lines }: { lines: Array<{ kind: string; text: string }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length]);
  return (
    <div className="code-mode-section">
      <div className="code-mode-section-head">
        Output <span className="code-mode-live" data-live>live</span>
      </div>
      <div className="code-mode-stream" ref={ref} data-terminal>
        {lines.map((line, index) => (
          <div className="code-mode-stream-line" data-kind={line.kind} key={index}>{line.text.replace(/\n$/, "")}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * What the script called, in order.
 *
 * Deliberately without outputs. See the note at the top of this file: the
 * point of the feature is that this data never crossed the boundary, so
 * showing it here would undo the saving the model was making.
 */
function ToolLedger({ calls }: { calls: CodeModeToolCall[] }) {
  return (
    <div className="code-mode-section">
      <div className="code-mode-section-head">
        Reaper tools called <span className="code-mode-count">{calls.length}</span>
      </div>
      <ul className="code-mode-calls">
        {calls.map((call, index) => (
          /*
           * `data-failed`, not `data-ok`.
           *
           * The attribute was set on *success* and the stylesheet paints the
           * marker red for `[data-ok]`, so every call that worked got the ✕ and
           * every call that failed got the neutral bullet — the ledger reported
           * the exact inverse of what happened, and did it in the colour that
           * means "problem". jsdom cannot see it: `::before` content is not in
           * the DOM, so no unit test was ever going to catch it. A screenshot
           * did, on the first Code Mode run.
           *
           * Keyed on the failure rather than the success because a marker that
           * has to say "nothing is wrong here" is not a marker. The common case
           * is a call that worked, and it should render as a plain bullet.
           *
           * The trailing `tool-status` is gone with it. It was a second verdict
           * for the same fact, one column to the right of the first, so a
           * failed row read `✕ grep_search ENOENT 12ms ✕`. One marker per row,
           * on the left edge, where the eye scanning a forty-call ledger
           * actually is.
           */
          <li className="code-mode-call" data-failed={call.ok ? undefined : true} key={`${call.name}-${index}`}>
            {/*
              The tool's name, beautified — `Write file`, not `write_file`.
              The same label rule the row uses, so the ledger naming a tool the
              script called and the row naming a tool the model called read the
              same way. The key is still the raw name: this is a label, not an
              identifier anybody needs to copy.
            */}
            <span className="code-mode-call-name">{toolLabel(call.name)}</span>
            {call.error && <span className="code-mode-call-error" title={call.error}>{call.error.split(":")[0]}</span>}
            {/*
              The verdict, said in words for the readers the glyph cannot reach.
              The error text alone told a screen reader *what* went wrong but
              never that the row failed; `aria-hidden` on a decorative glyph
              does not make the information decorative.
            */}
            <span className="sr-only">{call.ok ? "succeeded" : "failed"}</span>
            <span className="code-mode-call-time">{formatDuration(call.durationMs)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The value that came back, and the console the script wrote.
 *
 * Both are collapsed behind a disclosure when they are long, because the
 * common case is a short answer that should be read at a glance and the
 * uncommon case is a 4 KB object that should not push the next turn off the
 * screen.
 */
function ResultView({ result }: { result: CodeModeResult }) {
  const [showRaw, setShowRaw] = useState(false);
  const serialized = result.value === undefined ? "undefined" : JSON.stringify(result.value, null, 2) ?? String(result.value);
  const long = serialized.length > 320;

  return (
    <>
      {result.console && result.console.length > 0 && (
        <div className="code-mode-section">
          <div className="code-mode-section-head">
            Console <span className="code-mode-count">{result.console.length}</span>
            {result.consoleTruncated && <span className="code-mode-warn">truncated</span>}
          </div>
          <div className="code-mode-stream" data-terminal>
            {result.console.map((entry, index) => (
              <div className="code-mode-stream-line" data-kind={entry.level} key={index}>{entry.text.replace(/\n$/, "")}</div>
            ))}
          </div>
        </div>
      )}

      {result.value !== undefined && (
        <div className="code-mode-section">
          <div className="code-mode-section-head">
            Result
            {result.resultTruncated && (
              <span className="code-mode-warn">cut to {formatBytes(result.resultBytes ?? 0)}</span>
            )}
            {long && (
              <button className="disclosure sub-disclosure code-mode-raw-toggle" aria-expanded={showRaw} onClick={() => setShowRaw((value) => !value)}>
                <span className="chevron" data-open={showRaw || undefined} aria-hidden="true">›</span>
                <span>{showRaw ? "Collapse" : "Show full value"}</span>
              </button>
            )}
          </div>
          <pre className="code-mode-result" data-result>{long && !showRaw ? `${serialized.slice(0, 320)}…` : serialized}</pre>
        </div>
      )}

      {result.note && <p className="code-mode-note">{result.note}</p>}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
