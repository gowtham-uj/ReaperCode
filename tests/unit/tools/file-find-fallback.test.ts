import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileViewerRegistry } from "../../../src/tools/viewer/viewer-registry.js";
import { LinterRegistry } from "../../../src/tools/viewer/linter-registry.js";
import { dispatchViewerTool } from "../../../src/tools/viewer/dispatch.js";
import { outputOf } from "../../helpers/tool-output.js";

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-file-find-"));
  return fn(root);
}

function ctx(workspaceRoot: string) {
  return {
    workspaceRoot,
    viewerRegistry: new FileViewerRegistry(),
    linterRegistry: new LinterRegistry(),
  };
}

test("file_find handles quoted plural query against singular shard paths", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(
      path.join(workspaceRoot, "manifest.json"),
      JSON.stringify({ manifest: [{ file: "payload/shard-001.txt" }] }, null, 2),
    );

    const result = await dispatchViewerTool(
      { id: "find-1", name: "file_find", args: { path: "manifest.json", pattern: '"shards"' } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = outputOf(result);
    assert.equal(output.kind, "file_find");
    assert.equal(output.matchedPattern, "shard");
    assert.match((output.window as string[]).join("\n"), /payload\/shard-001\.txt/);
  });
});

test("file_find handles case-insensitive heading queries", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(path.join(workspaceRoot, "task_prompt.md"), "# Task\n\n## Success Criteria\n\n- done\n");

    const result = await dispatchViewerTool(
      { id: "find-2", name: "file_find", args: { path: "task_prompt.md", pattern: "success criteria" } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = outputOf(result);
    assert.equal(output.kind, "file_find");
    assert.equal(output.matchedPattern, "success criteria");
    assert.match((output.window as string[]).join("\n"), /Success Criteria/);
  });
});

/*
 * `file_find` accepts a `start_line`, and it used to throw it away: dispatch
 * parsed the field, never passed it to the registry, and the registry searched
 * from the *stored viewport* with wraparound. So a model that asked for the
 * next match after line 200 got the one at line 51, above where it said to
 * look. Silently returning a match from outside the requested range is worse
 * than returning nothing — the model has no way to notice.
 */

async function seedMatches(workspaceRoot: string): Promise<void> {
  await writeFile(
    path.join(workspaceRoot, "spread.ts"),
    Array.from({ length: 400 }, (_, i) =>
      i === 50 || i === 200 || i === 350 ? `MATCH_AT_${i}` : `// filler ${i}`,
    ).join("\n"),
  );
}

test("file_find honors start_line instead of wrapping to an earlier match", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await seedMatches(workspaceRoot);

    const result = await dispatchViewerTool(
      { id: "find-start", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_", start_line: 200 } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    const output = outputOf(result);
    assert.equal(output.matchedLine, 201, "the match at or after line 200 is the one at 201");
    assert.ok(
      output.matchedLine >= 200,
      `matched line ${output.matchedLine} is above the requested start_line`,
    );
  });
});

test("file_find within a start_line range does not peek above it", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await seedMatches(workspaceRoot);

    // Nothing matches at or below 300 except the one at 351. The match at 201
    // is below the origin and must not be reachable.
    const result = await dispatchViewerTool(
      { id: "find-range", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_", start_line: 300 } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, true);
    assert.equal(outputOf(result).matchedLine, 351);
  });
});

test("file_find past the last match reports not_found rather than wrapping", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await seedMatches(workspaceRoot);

    const result = await dispatchViewerTool(
      { id: "find-past", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_", start_line: 360 } },
      ctx(workspaceRoot),
    );

    assert.equal(result.ok, false, "there is no match at or after 360, so wrapping would be a lie");
    assert.match(result.error?.message ?? "", /at or after line 360/);
  });
});

test("file_find keeps its existing behavior when no start_line is given", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await seedMatches(workspaceRoot);
    const shared = { workspaceRoot, viewerRegistry: new FileViewerRegistry(), linterRegistry: new LinterRegistry() };

    const first = outputOf(
      await dispatchViewerTool({ id: "c1", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_" } }, shared),
    );

    assert.equal(first.matchedLine, 51, "the first match in the file wins when no origin is given");
    assert.ok(Array.isArray(first.window) && first.window.length > 0, "and the window is centered on it");

    // Pinned deliberately. The obvious intent of "call it again to get the next
    // one" does not hold: `readOrInit` returns the stored viewport untouched
    // for unchanged content, so the search re-runs from the same line and finds
    // the same match. That is a discovery about the tool, not something to
    // change here — advancing requires an explicit `start_line`, which is now
    // honored. Anyone changing this assertion should decide the cycling
    // question first rather than inherit it.
    const again = outputOf(
      await dispatchViewerTool({ id: "c2", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_" } }, shared),
    );
    assert.equal(again.matchedLine, 51, "a repeated call does not advance; pass start_line to move on");

    // The documented way to reach the next match, and what start_line is for.
    const next = outputOf(
      await dispatchViewerTool(
        { id: "c3", name: "file_find", args: { path: "spread.ts", pattern: "MATCH_AT_", start_line: 52 } },
        shared,
      ),
    );
    assert.equal(next.matchedLine, 201);
  });
});
