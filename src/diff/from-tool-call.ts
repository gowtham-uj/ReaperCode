/**
 * Derive a file change and its diff from a tool call.
 *
 * Every write tool in this codebase already carries everything needed to
 * describe the change it made, and each carries it in a different shape:
 * `edit_file` has the two strings, `apply_patch_edit` has a finished unified
 * diff, `write_file` has the new content in full, and the viewer's `file_edit`
 * has a line range plus the text it expected to find there. This module reads
 * all four and returns one shape, so the transcript projection stays a switch
 * over names and this stays the only place that knows what a tool's arguments
 * mean.
 *
 * It deliberately does no I/O. Reading the file would give the *current*
 * content, which for the case that matters least is the same as the change and
 * for the case that matters most is not: an edit followed by a second edit to
 * the same file would report the second one's before-text as the result of the
 * first. Deriving from the call is both cheaper and more correct.
 *
 * What each tool can and cannot tell us, and what this does about it:
 *
 * | tool               | before      | after       | position   |
 * |--------------------|-------------|-------------|------------|
 * | apply_patch_edit   | in the patch| in the patch| in the patch |
 * | file_edit          | expected_content (optional) | new_content | start_line |
 * | edit_file          | oldString   | newString   | none       |
 * | write_file         | unknown     | content     | none       |
 * | delete_file        | unknown     | empty       | none       |
 *
 * Where the position is unknown the hunk is emitted without a header, so the
 * transcript renders no gutter rather than one counting from 1. Where the before
 * side is unknown (`write_file` overwriting, `delete_file`) only the additions
 * or the removal marker are shown, because inventing the other side is how a
 * diff becomes a lie.
 */
import { fromLines, toLines, unifiedDiff, type DiffResult } from "./unified.js";

export interface DerivedChange {
  path: string;
  /** The tool that made the change. Kept verbatim so a reader can tell a
   *  rewrite from a patch without a mapping table here. */
  kind: string;
  diff?: string;
  additions?: number;
  removals?: number;
  truncated?: boolean;
}

/** Tool names that change a file, and therefore belong on a `fileChange` item. */
export const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "file_edit",
  "apply_patch_edit",
  "apply_patch",
  "delete_file",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The change a tool call made, or undefined when the call is not a file change.
 *
 * Returns an empty array rather than undefined when the tool *is* a file change
 * but its arguments name no path: the projection still wants a `fileChange`
 * item with no changes, because dropping it would make the row vanish from the
 * transcript entirely and the call would appear to have not happened.
 */
export function changesFromToolCall(name: string, args: unknown, output?: unknown): DerivedChange[] | undefined {
  if (!FILE_CHANGE_TOOLS.has(name)) return undefined;
  const record = asRecord(args) ?? {};

  if (name === "apply_patch_edit" || name === "apply_patch") return changesFromPatch(name, record);
  if (name === "edit_file") return changesFromEdits(name, record);
  if (name === "file_edit") return changesFromViewerEdit(name, record, asRecord(output));
  if (name === "delete_file") {
    const path = asString(record.path);
    return path ? [{ path, kind: name }] : [];
  }
  return changesFromWrite(name, record);
}

/**
 * `apply_patch_edit` hands over a finished patch, including its own headers.
 *
 * It is passed through untouched rather than re-parsed and re-emitted. The
 * patch already names each file and already carries correct hunk headers, and
 * running it through `structuredPatch` would mean diffing text against itself
 * to recover something we were given. Splitting on the file headers is the only
 * work needed, and it is what lets a multi-file patch produce one change per
 * file rather than one card listing them all.
 */
function changesFromPatch(name: string, record: Record<string, unknown>): DerivedChange[] {
  const patch = asString(record.patch);
  if (!patch) return [];
  /*
   * A dry run reports what would change, and the transcript should not claim it
   * did. The flag is on the args, so this is the one place that can tell.
   */
  const suffix = record.dry_run === true ? " (dry run)" : "";
  const changes: DerivedChange[] = [];
  for (const block of splitPatchByFile(patch)) {
    const diff = block.text.trimEnd();
    if (!diff) continue;
    const counts = countDiffLines(diff);
    changes.push({
      path: `${block.path}${suffix}`,
      kind: name,
      diff,
      ...counts,
    });
  }
  return changes;
}

interface PatchBlock { path: string; text: string }

/**
 * Split a multi-file unified diff at its `--- ` headers.
 *
 * Line-based rather than a regex over the whole string so a `--- ` appearing
 * inside a hunk's content cannot start a new file: a header only counts at the
 * start of a line that is followed by a `+++ ` line, which is exactly the rule
 * `parsePatch` uses when it applies the patch.
 */
function splitPatchByFile(patch: string): PatchBlock[] {
  const lines = patch.split("\n");
  const blocks: PatchBlock[] = [];
  let current: { path: string; lines: string[] } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      if (current) blocks.push({ path: current.path, text: current.lines.join("\n") });
      const next = (lines[i + 1] ?? "").slice(4).trim();
      // `+++ b/src/f.ts` and `+++ /dev/null` both appear; the reader wants the
      // path without the side prefix, and `/dev/null` means a deletion, which
      // is better named by the old side's path.
      const newPath = next === "/dev/null" ? line.slice(4).trim() : next;
      current = { path: newPath.replace(/^[ab]\//, ""), lines: [line, lines[i + 1]!] };
      i++;
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push({ path: current.path, text: current.lines.join("\n") });
  return blocks;
}

/** Count `+` and `-` body lines, ignoring the `+++`/`---` file headers. */
function countDiffLines(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) removals++;
  }
  return { additions, removals };
}

/**
 * `edit_file` is a list of exact search-and-replace pairs.
 *
 * One hunk per edit, each without a header. The call carries no line number, and
 * the file it edits is not necessarily readable from here, so the alternative
 * would be to guess a position. The UI renders no gutter for a headerless hunk,
 * which is the documented behaviour for exactly this case.
 */
function changesFromEdits(name: string, record: Record<string, unknown>): DerivedChange[] {
  const path = asString(record.path);
  if (!path) return [];
  const edits = Array.isArray(record.edits) ? record.edits : [];
  const parts: string[] = [];
  let additions = 0;
  let removals = 0;
  let truncated = false;

  for (const entry of edits) {
    const edit = asRecord(entry);
    const before = asString(edit?.oldString);
    const after = asString(edit?.newString);
    if (before === undefined || after === undefined) continue;
    const result: DiffResult = unifiedDiff(fromLines(toLines(before)), fromLines(toLines(after)));
    additions += result.additions;
    removals += result.removals;
    if (result.truncated) truncated = true;
    if (result.diff) parts.push(result.diff);
  }

  if (parts.length === 0) return [{ path, kind: name }];
  return [{ path, kind: name, diff: parts.join("\n"), additions, removals, ...(truncated ? { truncated: true } : {}) }];
}

/**
 * The viewer's `file_edit`, which can carry a real header.
 *
 * Three sources for the before side, in order of how much they can be trusted:
 *
 *  1. `replacedText` on the *result*, which the dispatch captured from the file
 *     as it actually was. This is the only source that is right when a model
 *     omits `expected_content`, which is the common case.
 *  2. `expected_content` on the args, which is what the model asserted was
 *     there. Correct when supplied, but optional.
 *  3. Nothing, in which case the new text renders as additions with no header.
 *
 * The result wins because it is observed rather than asserted. A model that
 * passed the wrong `expected_content` would have had its edit refused or
 * relocated, so the two only disagree in cases where the argument is stale.
 */
function changesFromViewerEdit(name: string, record: Record<string, unknown>, output: Record<string, unknown> | undefined): DerivedChange[] {
  const path = asString(record.path) ?? asString(output?.path);
  if (!path) return [];
  const after = asString(record.new_content);
  if (after === undefined) return [{ path, kind: name }];
  /*
   * The result wins only when it actually recorded something.
   *
   * `replacedText` is an empty string for a creation, which is a real answer and
   * not a missing one: it says the edit added lines where there were none. But
   * `??` treats `""` as present, so a creation with an `expected_content` in its
   * arguments would ignore the argument and diff against nothing. Testing for a
   * non-empty string keeps both readings: an empty result means "nothing was
   * replaced" only when the arguments do not claim otherwise.
   */
  const fromResult = asString(output?.replacedText);
  const before = fromResult ? fromResult : asString(record.expected_content);
  // The dispatch reports the line the replacement started at, which is more
  // reliable than the request's `start_line` because a relocated edit moved.
  const start = asNumber(output?.replacedStartLine) ?? asNumber(record.start_line);

  const result = unifiedDiff(
    before === undefined ? "" : fromLines(toLines(before)),
    fromLines(toLines(after)),
    before === undefined ? {} : { ...(start !== undefined ? { start } : {}) },
  );
  if (!result.diff) return [{ path, kind: name }];
  return [{
    path,
    kind: name,
    diff: result.diff,
    additions: result.additions,
    removals: result.removals,
    ...(result.truncated ? { truncated: true } : {}),
  }];
}

/**
 * `write_file` gives the whole new content and nothing of the old.
 *
 * So the card shows the new file and the counts it can honestly stand behind.
 * When the file was created this is exactly right and the header is real; when
 * it was overwritten the before side is genuinely unknown from here, and the
 * diff stays headerless rather than claiming the content starts at line 1 of a
 * file that already existed. The projection marks a create as such by checking
 * `bytesWritten` against the content length, which is how the executor reports
 * that nothing was read first.
 */
function changesFromWrite(name: string, record: Record<string, unknown>): DerivedChange[] {
  const path = asString(record.path);
  if (!path) return [];
  const content = asString(record.content);
  if (content === undefined) return [{ path, kind: name }];

  const result = unifiedDiff("", fromLines(toLines(content)));
  if (!result.diff) return [{ path, kind: name }];
  return [{
    path,
    kind: name,
    diff: result.diff,
    additions: result.additions,
    removals: result.removals,
    ...(result.truncated ? { truncated: true } : {}),
  }];
}
