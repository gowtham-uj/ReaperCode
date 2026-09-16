/**
 * Deriving a file change from a tool call.
 *
 * The interesting cases are the ones where a tool *cannot* say everything about
 * the change it made, because that is where a diff turns from a description into
 * a false one. `edit_file` has no line number, `write_file` has no before side,
 * and a patch can cover several files. Each of those has a wrong answer that
 * looks plausible on screen, and the tests below are about the difference: a
 * hunk header with a made-up position, a before side invented to make the diff
 * look symmetric, or one card listing four files as one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { changesFromToolCall, FILE_CHANGE_TOOLS } from "../../src/diff/from-tool-call.js";
import { unifiedDiff } from "../../src/diff/unified.js";

test("edit_file emits a diff with no hunk header", () => {
  const changes = changesFromToolCall("edit_file", {
    path: "src/a.ts",
    edits: [{ oldString: "const x = 1;", newString: "const x = 2;" }],
  });
  assert.equal(changes?.length, 1);
  const change = changes![0]!;
  assert.equal(change.path, "src/a.ts");
  assert.equal(change.kind, "edit_file");
  assert.equal(change.additions, 1);
  assert.equal(change.removals, 1);
  /*
   * The bare `@@` is the load-bearing part. The call names no line, so a real
   * header would have to guess, and the UI renders a gutter from whatever
   * number it is given. Asserting on it here means a future "improvement" that
   * fills in `-1,1` has to delete this test first.
   */
  assert.match(change.diff!, /^@@\n/);
  assert.doesNotMatch(change.diff!, /^@@ -\d/);
});

test("edit_file covers several edits in one call", () => {
  const changes = changesFromToolCall("edit_file", {
    path: "src/a.ts",
    edits: [
      { oldString: "one", newString: "one changed" },
      { oldString: "two", newString: "two changed" },
    ],
  });
  const change = changes![0]!;
  assert.equal(change.additions, 2);
  assert.equal(change.removals, 2);
  // One hunk boundary per edit, so the renderer does not number the second
  // edit's rows as a continuation of the first's.
  assert.equal(change.diff!.match(/^@@/gm)?.length, 2);
});

test("file_edit with expected_content carries a real hunk header", () => {
  const changes = changesFromToolCall("file_edit", {
    path: "src/a.ts",
    start_line: 100,
    new_content: "line two\nline THREE\n",
    expected_content: "line two\nline three\n",
  });
  const change = changes![0]!;
  assert.equal(change.additions, 1);
  assert.equal(change.removals, 1);
  // The numbers must point at the file, not at the fragment. The edited block
  // starts at line 100, so the context line is 100 and the change is at 101.
  assert.match(change.diff!, /^@@ -100,2 \+100,2 @@/);
  assert.match(change.diff!, / line two/);
  assert.match(change.diff!, /-line three/);
  assert.match(change.diff!, /\+line THREE/);
});

test("file_edit without expected_content does not claim a position", () => {
  const changes = changesFromToolCall("file_edit", {
    path: "src/a.ts",
    start_line: 100,
    new_content: "brand new\n",
  });
  const change = changes![0]!;
  /*
   * `start_line` is present here, and this is the case worth pinning: the tool
   * *does* know where the edit goes, but with no before text there is nothing
   * to diff against, so the only honest diff is all-additions. A header would
   * be wrong even though the number is real, because the diff is not a
   * description of the file at that position.
   */
  assert.match(change.diff!, /^@@\n/);
  assert.equal(change.additions, 1);
  assert.equal(change.removals, 0);
});

test("write_file shows the new content and claims no removals", () => {
  const changes = changesFromToolCall("write_file", { path: "notes.md", content: "hello\nworld\n" });
  const change = changes![0]!;
  assert.equal(change.additions, 2);
  assert.equal(change.removals, 0);
  assert.match(change.diff!, /\+hello/);
  assert.match(change.diff!, /\+world/);
});

test("write_file against existing content does not invent a before side", () => {
  /*
   * The failure this guards is subtle and worth naming: a rewrite is the one
   * write that *destroys* information, and a diff that renders it as pure
   * additions reads like a file that grew. There is no before side available
   * anywhere in the call, so the only correct output is one-sided.
   */
  const changes = changesFromToolCall("write_file", { path: "notes.md", content: "completely different\n" });
  const change = changes![0]!;
  assert.equal(change.removals, 0);
  assert.doesNotMatch(change.diff!, /^-/m);
});

test("apply_patch_edit splits a multi-file patch into one change per file", () => {
  const patch = [
    "--- a/src/one.ts",
    "+++ b/src/one.ts",
    "@@ -1,2 +1,3 @@",
    " keep",
    "-gone",
    "+added",
    "+more",
    "--- a/src/two.ts",
    "+++ b/src/two.ts",
    "@@ -5,1 +5,1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const changes = changesFromToolCall("apply_patch_edit", { patch });
  assert.equal(changes?.length, 2);
  assert.equal(changes![0]!.path, "src/one.ts");
  assert.equal(changes![0]!.additions, 2);
  assert.equal(changes![0]!.removals, 1);
  assert.equal(changes![1]!.path, "src/two.ts");
  assert.equal(changes![1]!.additions, 1);
  assert.equal(changes![1]!.removals, 1);
  /*
   * The patch's own headers survive, so the UI can number these rows. They are
   * not at the string start: a file block keeps its `---`/`+++` lines, which the
   * renderer drops as meta rows. Only a derived diff starts at `@@`.
   */
  assert.match(changes![0]!.diff!, /^--- a\/src\/one\.ts\n\+\+\+ b\/src\/one\.ts\n@@ -1,2 \+1,3 @@/);
});

test("a dry run says so on the path", () => {
  const patch = "--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const changes = changesFromToolCall("apply_patch_edit", { patch, dry_run: true });
  assert.equal(changes![0]!.path, "f.ts (dry run)");
});

test("a deletion names the file it removed", () => {
  const patch = ["--- a/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-one", "-two", ""].join("\n");
  const changes = changesFromToolCall("apply_patch_edit", { patch });
  // `/dev/null` is the new side of a deletion, so the old side's path is the
  // only name that tells a reader which file went away.
  assert.equal(changes![0]!.path, "gone.ts");
  assert.equal(changes![0]!.removals, 2);
});

test("a file change with no usable arguments still yields an item", () => {
  /*
   * Dropping the row would be worse than an empty one: the call happened, and a
   * transcript that omits it shows an agent that did nothing between two
   * messages. The projection turns an empty `changes` into a card with no body.
   */
  assert.deepEqual(changesFromToolCall("write_file", {}), []);
  assert.deepEqual(changesFromToolCall("delete_file", {}), []);
});

test("delete_file names the path it removed", () => {
  const changes = changesFromToolCall("delete_file", { path: "src/old.ts" });
  assert.deepEqual(changes, [{ path: "src/old.ts", kind: "delete_file" }]);
});

test("a non-file tool is not a file change", () => {
  // The membership test is what decides whether a row renders as an edit card
  // or as a generic tool card, so a false positive here would mislabel calls.
  assert.equal(changesFromToolCall("bash", { cmd: "ls" }), undefined);
  assert.equal(changesFromToolCall("file_view", { path: "a.ts" }), undefined);
  assert.equal(changesFromToolCall("grep_search", { pattern: "x" }), undefined);
});

test("every file change tool the projection knows is covered here", () => {
  /*
   * A tool added to the set without a branch in `changesFromToolCall` would
   * silently produce `[]` and render as an empty card, which is the exact bug
   * this module was written to fix. This asserts that each name in the set
   * actually yields a path from a plausible argument object.
   */
  for (const name of FILE_CHANGE_TOOLS) {
    const args = name.startsWith("apply_patch")
      ? { patch: "--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n" }
      : name === "edit_file"
        ? { path: "f.ts", edits: [{ oldString: "a", newString: "b" }] }
        : name === "file_edit"
          ? { path: "f.ts", start_line: 1, new_content: "b\n", expected_content: "a\n" }
          : name === "write_file"
            ? { path: "f.ts", content: "b\n" }
            : { path: "f.ts" };
    const changes = changesFromToolCall(name, args);
    assert.ok(changes && changes.length > 0, `${name} produced no change`);
    assert.equal(changes[0]!.path, "f.ts", `${name} lost the path`);
  }
});

test("a patch whose content contains a header-looking line is not split on it", () => {
  /*
   * A hunk body can contain a line that starts with `--- ` if the file being
   * edited is itself a diff, a markdown rule, or a YAML document. Splitting on
   * any `--- ` would cut the patch in half and report two files where there is
   * one, which is the same rule `parsePatch` uses when it applies the patch.
   */
  const patch = [
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,1 +1,3 @@",
    " title",
    "+--- a/not-a-header.md",
    "++++ b/not-a-header.md",
    "",
  ].join("\n");
  const changes = changesFromToolCall("apply_patch_edit", { patch });
  assert.equal(changes?.length, 1);
  assert.equal(changes![0]!.path, "notes.md");
});

test("a truncated diff reports the true counts and says it was cut", () => {
  const before = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");
  const after = Array.from({ length: 900 }, (_, index) => `changed ${index}`).join("\n");
  const result = unifiedDiff(before, after, { maxLines: 20 });
  assert.equal(result.truncated, true);
  /*
   * The counts are the point of returning them separately from the text. The
   * kept lines contain roughly a fifth of the 900 changes, so anything derived
   * by counting the returned diff would be wildly short of the real change.
   */
  assert.equal(result.additions, 900);
  assert.equal(result.removals, 900);
  assert.ok(result.diff!.split("\n").length <= 21, "diff exceeded its own cap");
  assert.match(result.diff!, /truncated/);
});

test("identical content produces no diff at all", () => {
  // A no-op write should render as a card with a path and nothing else, not as
  // an empty diff frame.
  assert.equal(unifiedDiff("same\ntext\n", "same\ntext\n").diff, undefined);
});

test("a trailing newline is not reported as a changed line", () => {
  /*
   * `"a\n".split("\n")` is `["a", ""]`, so a naive split makes the last line
   * empty and a file that merely gained its final newline shows a spurious
   * change. Every write tool here works in whole lines.
   */
  const result = unifiedDiff("a\nb\n", "a\nb\n");
  assert.equal(result.diff, undefined);
  assert.equal(result.additions, 0);
});

test("file_edit prefers the result's replaced text over the arguments", () => {
  /*
   * The case that reaches users most often, and the one that made a real live
   * transcript read wrong: a model calls `file_edit` with no `expected_content`,
   * so the arguments hold only the new text and an edit that replaced a line was
   * rendered as `+1 -0`. The dispatch reads the file before writing, so the old
   * text is in the result and the arguments are not the best source available.
   */
  const changes = changesFromToolCall(
    "file_edit",
    { path: "notes.md", start_line: 1, end_line: 1, new_content: "second line" },
    { kind: "file_edit", path: "notes.md", replacedText: "first line", replacedStartLine: 1 },
  );
  const change = changes![0]!;
  assert.equal(change.additions, 1);
  assert.equal(change.removals, 1, "a replacement was reported as pure addition");
  assert.match(change.diff!, /-first line/);
  assert.match(change.diff!, /\+second line/);
  // The result's line number is used, so the gutter points into the file.
  assert.match(change.diff!, /^@@ -1,1 \+1,1 @@/);
});

test("file_edit falls back to the arguments when the result recorded nothing", () => {
  /*
   * A creation reports `replacedText: ""`, which is a real answer: nothing was
   * replaced. But the arguments may still claim otherwise, and an empty result
   * must not silently override them. Treating `""` as present is how a
   * replacement gets rendered as an addition again, which is the bug this whole
   * result-carrying change exists to fix.
   */
  const changes = changesFromToolCall(
    "file_edit",
    { path: "notes.md", start_line: 1, end_line: 1, new_content: "brand new", expected_content: "old" },
    { kind: "file_edit", path: "notes.md", replacedText: "", replacedStartLine: 1 },
  );
  const change = changes![0]!;
  assert.equal(change.removals, 1, "the argument's before-side was ignored");
  assert.match(change.diff!, /-old/);
  assert.match(change.diff!, /\+brand new/);
});

test("file_edit with nothing recorded on either side is all additions", () => {
  // A genuine creation: the dispatch read no old text and the model asserted
  // none, so the card shows the new lines and claims no removals.
  const changes = changesFromToolCall(
    "file_edit",
    { path: "notes.md", start_line: 1, end_line: 1, new_content: "brand new" },
    { kind: "file_edit", path: "notes.md", replacedText: "" },
  );
  const change = changes![0]!;
  assert.equal(change.removals, 0);
  assert.match(change.diff!, /^@@\n\+brand new/);
});

test("a relocated edit is numbered where it actually landed", () => {
  // `expected_content` can be found somewhere other than the requested range, in
  // which case the dispatch reports where it really applied. Numbering the
  // request's range would put the diff at a line the edit never touched.
  const changes = changesFromToolCall(
    "file_edit",
    { path: "a.ts", start_line: 10, end_line: 10, new_content: "x\n" },
    { kind: "file_edit", path: "a.ts", replacedText: "y", replacedStartLine: 250 },
  );
  assert.match(changes![0]!.diff!, /^@@ -250,1 \+250,1 @@/);
});
