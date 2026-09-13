import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileViewerRegistry } from "../../../src/tools/viewer/viewer-registry.js";
import { LinterRegistry } from "../../../src/tools/viewer/linter-registry.js";
import { dispatchViewerTool } from "../../../src/tools/viewer/dispatch.js";
import { outputOf } from "../../helpers/tool-output.js";

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-viewer-anchor-"));
  return fn(root);
}

function ctx(workspaceRoot: string) {
  return {
    workspaceRoot,
    viewerRegistry: new FileViewerRegistry(),
    linterRegistry: new LinterRegistry(),
  };
}

const SAMPLE = [
  "line one",
  "line two",
  "target alpha",
  "target beta",
  "line five",
  "line six",
].join("\n");

test("file_edit refuses to splice when expected_content is not at the given range", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "sample.txt");
    await writeFile(file, SAMPLE);

    const result = await dispatchViewerTool(
      {
        id: "e1",
        name: "file_edit",
        args: {
          path: "sample.txt",
          start_line: 1,
          end_line: 2,
          expected_content: "nothing like this exists",
          new_content: "REPLACED",
        },
      },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "stale_range");
    assert.equal(await readFile(file, "utf8"), SAMPLE, "file must be untouched");
  });
});

test("file_edit relocates to the unique anchor match when line numbers drifted", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "sample.txt");
    await writeFile(file, SAMPLE);

    const result = await dispatchViewerTool(
      {
        id: "e2",
        name: "file_edit",
        args: {
          path: "sample.txt",
          // Stale by two lines, as it would be after an earlier insertion.
          start_line: 1,
          end_line: 2,
          expected_content: "target alpha\ntarget beta",
          new_content: "target gamma",
        },
      },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = outputOf(result);
    assert.deepEqual(output.relocatedFrom, { startLine: 1, endLine: 2 });
    const after = await readFile(file, "utf8");
    assert.equal(
      after,
      ["line one", "line two", "target gamma", "line five", "line six"].join("\n"),
    );
  });
});

test("file_edit refuses an ambiguous anchor rather than guessing", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "dupes.txt");
    const content = ["dup", "a", "dup", "b"].join("\n");
    await writeFile(file, content);

    const result = await dispatchViewerTool(
      {
        id: "e3",
        name: "file_edit",
        args: {
          path: "dupes.txt",
          start_line: 2,
          end_line: 2,
          expected_content: "dup",
          new_content: "changed",
        },
      },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "stale_range");
    assert.match(result.error?.message ?? "", /more than one place/);
    assert.equal(await readFile(file, "utf8"), content);
  });
});

test("file_edit returns the post-edit window so the next edit uses fresh line numbers", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "sample.txt");
    await writeFile(file, SAMPLE);
    const context = ctx(workspaceRoot);

    const result = await dispatchViewerTool(
      {
        id: "e4",
        name: "file_edit",
        args: {
          path: "sample.txt",
          start_line: 3,
          end_line: 4,
          expected_content: "target alpha\ntarget beta",
          new_content: "one\ntwo\nthree",
        },
      },
      context,
    );

    assert.equal(result.ok, true);
    const output = outputOf(result);
    assert.equal(output.totalLines, 7);
    assert.match((output.window as string[]).join("\n"), /3: one/);
    const state = context.viewerRegistry.get(path.join(workspaceRoot, "sample.txt"));
    assert.equal(state?.anchorLine, 3);
    assert.equal(state?.totalLines, 7);
  });
});

test("unanchored file_edit still applies, for callers that have just read the range", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "sample.txt");
    await writeFile(file, SAMPLE);

    const result = await dispatchViewerTool(
      { id: "e5", name: "file_edit", args: { path: "sample.txt", start_line: 1, end_line: 1, new_content: "first" } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    assert.match(await readFile(file, "utf8"), /^first\nline two/);
  });
});

test("repeated argument-less file_view advances instead of re-serving page 1", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const lines = Array.from({ length: 130 }, (_, i) => `row ${i + 1}`).join("\n");
    await writeFile(path.join(workspaceRoot, "big.txt"), lines);
    const context = ctx(workspaceRoot);

    const first = outputOf(
      await dispatchViewerTool({ id: "v1", name: "file_view", args: { path: "big.txt" } }, context),
    );
    assert.equal(first.startLine, 1);
    assert.equal(first.truncated, true);
    assert.equal(first.note, undefined);

    const second = outputOf(
      await dispatchViewerTool({ id: "v2", name: "file_view", args: { path: "big.txt" } }, context),
    );
    assert.equal(second.startLine, first.endLine);
    assert.match(String(second.note), /advanced to the next window/);

    const third = outputOf(
      await dispatchViewerTool({ id: "v3", name: "file_view", args: { path: "big.txt" } }, context),
    );
    assert.equal(third.startLine, second.endLine);

    // Past the end of the file the viewer says so instead of looping silently.
    const fourth = outputOf(
      await dispatchViewerTool({ id: "v4", name: "file_view", args: { path: "big.txt" } }, context),
    );
    assert.match(String(fourth.note), /end of/);
  });
});

test("explicit start_line is always honored and never auto-advanced", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const lines = Array.from({ length: 130 }, (_, i) => `row ${i + 1}`).join("\n");
    await writeFile(path.join(workspaceRoot, "big.txt"), lines);
    const context = ctx(workspaceRoot);

    await dispatchViewerTool({ id: "v1", name: "file_view", args: { path: "big.txt" } }, context);
    const pinned = outputOf(
      await dispatchViewerTool({ id: "v2", name: "file_view", args: { path: "big.txt", start_line: 10 } }, context),
    );
    assert.equal(pinned.startLine, 10);
    assert.equal(pinned.note, undefined);
  });
});
