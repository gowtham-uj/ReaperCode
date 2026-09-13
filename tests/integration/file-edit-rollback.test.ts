/**
 * Phase 3: end-to-end test of the viewer tools through ToolExecutor.
 *
 * Verifies:
 *   1. file_view returns a numbered window
 *   2. reading further is an explicit start_line, not a cursor
 *   3. file_find recenters on the matched line
 *   4. file_edit on a clean file persists and post-edit lint ok=true
 *   5. file_edit on a malformed file FAILS lint, returns rolledBack=true,
 *      and the on-disk file is BYTE-IDENTICAL to the pre-edit version.
 *
 * This is the phase-3 integration gate. If it passes, the viewer tools are
 * correctly wired into the executor's dispatch.
 */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolExecutor } from "../../src/tools/executor.js";
import type { ToolCall } from "../../src/tools/types.js";
import { outputOf } from "../helpers/tool-output.js";

async function withWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "reaper-viewer-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeCall(name: string, args: unknown): ToolCall {
  return { id: randomUUID(), name, args } as unknown as ToolCall;
}

interface ExecuteReturnShape {
  ok: boolean;
  /*
   * `unknown`, matching `ToolResult.output`. It was `string` here and the
   * viewer tools really did hand back JSON text, so the cast held — but that
   * was the defect, not the contract: see `tests/helpers/tool-output.ts`.
   */
  output: unknown;
  durationMs: number;
  error?: { code: string; message: string; details?: unknown };
  name: string;
}

function buildExecutor(workspaceRoot: string): ToolExecutor {
  return new ToolExecutor({
    workspaceRoot,
    runId: "run-test",
    sessionId: "session-test",
    traceId: "trace-test",
    logLevel: "info",
    safetyProfile: { mode: "permissive", policy: "default" },
  } as never);
}

const execute = (e: ToolExecutor, c: ToolCall) =>
  (e as unknown as { execute: (c: ToolCall) => Promise<ExecuteReturnShape> }).execute(c);

test("file_view returns a numbered window", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "a.txt");
    await writeFile(file, "alpha\nbeta\ngamma\ndelta\nepsilon\n", "utf8");
    const e = buildExecutor(workspaceRoot);
    const r = await execute(e, makeCall("file_view", { path: "a.txt", start_line: 1, window: 3 }));
    assert.equal(r.ok, true);
    const obj = outputOf<{ kind: string; window: string[] }>(r);
    assert.equal(obj.kind, "file_view");
    assert.equal(obj.window.length, 3);
    assert.match(obj.window[0] ?? "", /^1: alpha$/);
  });
});

test("reading further is an explicit window, not a cursor", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "b.txt");
    await writeFile(file, Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n", "utf8");
    const e = buildExecutor(workspaceRoot);

    // The retired `file_scroll` name still resolves — it is aliased onto
    // `file_view` — but its `direction`/`lines` describe a cursor that no longer
    // exists. Honouring them would mean keeping a per-run viewport this
    // consolidation removed, so they are dropped and the call reads from the
    // top. A second identical call returns the same window: nothing is carried
    // between calls, which is the property the old tool could not offer.
    const scrolled = await execute(e, makeCall("file_scroll", { path: "b.txt", direction: "down", lines: 5 }));
    assert.equal(scrolled.ok, true);
    const scrollObj = outputOf<{ startLine: number }>(scrolled);
    assert.equal(scrollObj.startLine, 1);

    // Reading further is the caller saying where.
    const next = await execute(e, makeCall("file_view", { path: "b.txt", start_line: 6, window: 5 }));
    assert.equal(next.ok, true);
    const nextObj = outputOf<{ startLine: number; window: string[] }>(next);
    assert.equal(nextObj.startLine, 6);
    assert.match(nextObj.window[0] ?? "", /^6: line6$/);

    // And `end_line` is translated into a window size, so a model that says
    // "lines 10 to 12" gets three lines rather than an error.
    const ranged = await execute(e, makeCall("file_view", { path: "b.txt", start_line: 10, end_line: 12 }));
    assert.equal(ranged.ok, true);
    const rangedObj = outputOf<{ startLine: number; window: string[] }>(ranged);
    assert.equal(rangedObj.startLine, 10);
    assert.equal(rangedObj.window.length, 3);
    assert.match(rangedObj.window[2] ?? "", /^12: line12$/);
  });
});

test("file_find recenters on the matched line", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "c.txt");
    await writeFile(
      file,
      Array.from({ length: 30 }, (_, i) => (i === 17 ? "needle" : `line${i + 1}`)).join("\n") + "\n",
      "utf8",
    );
    const e = buildExecutor(workspaceRoot);
    const r = await execute(e, makeCall("file_find", { path: "c.txt", pattern: "needle" }));
    assert.equal(r.ok, true);
    const obj = outputOf<{ matchedLine: number; matchCount: number }>(r);
    assert.equal(obj.matchedLine, 18);
    assert.equal(obj.matchCount, 1);
  });
});

test("file_edit on a clean file persists and lints ok", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "d.json");
    await writeFile(file, '{\n  "version": 1,\n  "name": "x"\n}\n', "utf8");
    const e = buildExecutor(workspaceRoot);
    const r = await execute(e, makeCall("file_edit", { path: "d.json", start_line: 2, end_line: 2, new_content: '  "version": 1,' }));
    assert.equal(r.ok, true);
    const obj = outputOf<{ kind: string; lintVerdict?: { ok: boolean } }>(r);
    assert.equal(obj.kind, "file_edit");
    assert.equal(obj.lintVerdict?.ok, true);
    const after = await readFile(file, "utf8");
    assert.match(after, /"version": 1,/);
  });
});

test("file_edit on a malformed TypeScript file FAILS lint, rolls back, byte-identity preserved", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "f.ts");
    const original = 'export const x: number = 1;\nexport const y: number = 2;\n';
    await writeFile(file, original, "utf8");
    const e = buildExecutor(workspaceRoot);
    // Truncate mid-expression to break the parser.
    const r = await execute(
      e,
      makeCall("file_edit", {
        path: "f.ts",
        start_line: 1,
        end_line: 2,
        new_content: "export const x: number  ",
      }),
    );
    assert.equal(r.ok, true);
    const obj = outputOf<{
      rolledBack?: boolean;
      lintVerdict?: { ok: boolean; source: string; language: string };
    }>(r);
    assert.equal(obj.lintVerdict?.source, "manifest_pinned");
    assert.equal(obj.lintVerdict?.ok, false);
    assert.equal(obj.rolledBack, true);
    const after = await readFile(file, "utf8");
    assert.equal(after, original, "file must be byte-identical after a lint failure");
  });
});

test("file_edit on a file with no linter (not in manifest) permits the edit (current Phase-3 behavior)", async () => {
  // The Phase-3 dispatcher returns a permissive-pass verdict when the
  // manifest has no entry for the file extension. Future linters add via
  // `linters/manifest.json`. Until then, file_edit goes through.
  await withWorkspace(async (workspaceRoot) => {
    const file = path.join(workspaceRoot, "g.txt");
    await writeFile(file, "hello\n", "utf8");
    const e = buildExecutor(workspaceRoot);
    const r = await execute(
      e,
      makeCall("file_edit", {
        path: "g.txt",
        start_line: 1,
        end_line: 1,
        new_content: "world",
      }),
    );
    assert.equal(r.ok, true);
    const obj = outputOf<{ lintVerdict?: { source: string } }>(r);
    assert.equal(obj.lintVerdict?.source, "fallback_permissive");
    const after = await readFile(file, "utf8");
    assert.match(after, /world/);
  });
});

test("Phase 4 contract: viewer tools ARE in CORE_TOOL_NAMES; legacy tools are gone", async () => {
  const { CORE_TOOL_NAMES, toolRegistry } = await import("../../src/tools/registry.js");
  assert.ok(CORE_TOOL_NAMES.has("file_view"));
  assert.ok(CORE_TOOL_NAMES.has("file_edit"));
  assert.ok(!Object.prototype.hasOwnProperty.call(toolRegistry, "read_file"));
  assert.ok(!Object.prototype.hasOwnProperty.call(toolRegistry, "replace_in_file"));
});

// Suppress an unused-import warning for mkdir in case future tests use it.
void mkdir;
