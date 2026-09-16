/**
 * Unified diffs for the transcript.
 *
 * There is already a `git diff` path in `runtime/diff-state.ts`, and it is the
 * right tool for a checkpoint: it sees the whole worktree and it is what a
 * restore replays. It is the wrong tool for a transcript row. It shells out
 * once per file, it only answers inside a git repository, and the transcript
 * has to describe an edit in a workspace that may not be one. Worse, it reports
 * the whole file's diff, so a card for an edit the agent made in this turn would
 * also list ten changes someone made last week.
 *
 * So a tool call's diff is derived from the call itself, where the before and
 * after text are both present and no I/O is needed.
 *
 * The line numbers are the part worth getting right, and they are the reason
 * this is a module and not a one-line call into `diff`. A unified hunk header
 * says where the changed lines live in the file, and only some tools tell us:
 * `apply_patch_edit` carries a patch that already has real headers, and a viewer
 * `file_edit` knows its `start_line`. An `edit_file` call carries two strings
 * and no position at all. For that case the hunk is emitted *without* a header
 * on purpose, because `numberDiff` in the UI renders no gutter rather than a
 * gutter counting from 1, and a confident wrong line number is worse than none.
 */
import { structuredPatch } from "diff";

/**
 * Cap on lines in one diff.
 *
 * The transcript previews 14 lines and the card can be opened, so this is not
 * about the DOM. It is about the websocket payload: a `write_file` that
 * rewrites a 10,000-line generated file would otherwise put 20,000 diff lines
 * on the wire for a row that renders 14 of them, on every reconnect.
 *
 * Truncation is why the additions and removals counts are returned separately
 * instead of being derived from the text by the client: a truncated diff no
 * longer contains every `+`, so counting the lines it does contain would
 * under-report the change.
 */
export const DEFAULT_MAX_DIFF_LINES = 400;

/** Context lines kept either side of a change. Three is the diff default and
 *  what every editor shows. */
const DEFAULT_CONTEXT = 3;

export interface DiffResult {
  /** Unified diff text, or undefined when the two sides are identical. */
  diff?: string;
  additions: number;
  removals: number;
  /** True when the diff was cut short, so a reader is not shown a partial
   *  change as if it were the whole one. */
  truncated?: boolean;
}

/**
 * A unified diff between two strings.
 *
 * `headerLines` decides whether the hunks carry real line numbers. Pass the
 * first line number when the caller knows it; omit it when the caller does not,
 * and the output stays headerless.
 */
export function unifiedDiff(before: string, after: string, options: {
  /** Header for a hunk, e.g. { start: 100 } for `@@ -100,...`. Omit when the
   *  position is unknown. */
  start?: number;
  context?: number;
  maxLines?: number;
} = {}): DiffResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;
  const context = options.context ?? DEFAULT_CONTEXT;

  const patch = structuredPatch("a", "b", before, after, "", "", { context });
  const additions = patch.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("+")).length, 0);
  const removals = patch.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.startsWith("-")).length, 0);
  if (patch.hunks.length === 0) return { additions: 0, removals: 0 };

  const lines: string[] = [];
  let truncated = false;
  for (const hunk of patch.hunks) {
    /*
     * The header carries the position when we have one and is otherwise the
     * bare `@@` marker that tells the renderer "this is a hunk boundary, show
     * no numbers". The UI drops the header line itself, so this only decides
     * whether the rows beneath it get a gutter.
     */
    lines.push(options.start === undefined
      ? "@@"
      : `@@ -${options.start + hunk.oldStart - 1},${hunk.oldLines} +${options.start + hunk.newStart - 1},${hunk.newLines} @@`);
    lines.push(...hunk.lines);
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
  }

  const kept = lines.slice(0, maxLines);
  if (kept.length < lines.length) truncated = true;
  /*
   * A trailing marker rather than silent truncation: a reader who opens the
   * card and sees the diff stop mid-file with no explanation has no way to tell
   * a complete small change from an incomplete large one.
   */
  if (truncated) kept.push(`@@ truncated: ${additions + removals} lines changed in total @@`);

  return {
    diff: kept.join("\n"),
    additions,
    removals,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Split a block of text into lines without inventing a trailing empty one.
 *
 * `"a\n".split("\n")` is `["a", ""]`, so diffing a file that ends in a newline
 * against one that does not reports a phantom change to an empty last line.
 * Every write tool here works in whole lines, so dropping one trailing empty
 * element is the correct normalization and removes that whole class of noise.
 */
export function toLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Rejoin lines, restoring the trailing newline the split removed. */
export function fromLines(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}
