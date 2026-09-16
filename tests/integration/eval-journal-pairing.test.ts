/**
 * A script's inner tool calls must not be journalled as the model's own calls.
 *
 * The reported failure was silent and expensive. Every `tools.*` call inside an
 * `eval` came back through the executor and wrote a top-level `tool_call`
 * trajectory row, keyed by the script's own call id — a bare `"1"`, `"2"`,
 * `"3"`. The journal projection turns each into a `role: "tool"` message, and
 * nothing in the top-level assistant turn announced those ids. On resume they
 * rehydrated as orphans that no `tool_calls` array answered, so the provider
 * pairing repair dropped them: a live session logged "38 unattributable tool
 * message(s) dropped" and the history quietly lost every inner call's result.
 *
 * The rows below are read straight out of the session journal, which is where
 * the damage showed up, rather than from the executor's return value — the eval
 * succeeded throughout, and a test that only checked the eval result would have
 * passed the whole time the journal was filling with orphans.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { TrajectoryLogger } from "../../src/logging/trajectory.js";

interface JournalRow {
  kind: string;
  type?: string;
  message?: { role?: string; tool_call_id?: string; name?: string };
}

async function readJournal(root: string, runId: string): Promise<JournalRow[]> {
  const file = path.join(root, ".reaper", "sessions", runId, "session.jsonl");
  const raw = await readFile(file, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalRow);
}

test("inner tool calls of an eval script do not appear as top-level tool messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-journal-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.txt"), "hello\n", "utf8");

    const runId = `eval-journal-${Date.now()}`;
    const trajectory = new TrajectoryLogger(root, { runId });
    const executor = new ToolExecutor({
      workspaceRoot: root,
      runId,
      sessionId: runId,
      traceId: runId,
      logLevel: "info",
      safetyProfile: "allow_all",
      trajectoryLogger: trajectory,
    });

    /*
     * A script that makes two inner calls and returns their result. Both go
     * through the real executor, which is exactly the path that used to journal
     * them at the top level.
     */
    const result = await executor.execute({
      id: "call_top_level_1",
      name: "eval",
      args: {
        code: `
const view = await tools.file_view({ path: "src/a.txt" });
const found = await tools.glob({ pattern: "src/**/*.txt" });
({ files: found.files.length, kind: view.kind });
`,
      },
    });
    assert.equal(result.ok, true, `eval failed: ${JSON.stringify(result.error ?? {})}`);

    const rows = await readJournal(root, runId);
    const toolRows = rows.filter((row) => row.kind === "entry" && row.message?.role === "tool");

    /*
     * One tool message, and it is the eval's. Before the fix there were three:
     * the eval plus two inner calls whose ids were `"1"` and `"2"`.
     */
    assert.equal(toolRows.length, 1, `expected only the eval's tool row, got: ${JSON.stringify(toolRows.map((r) => r.message))}`);
    assert.equal(toolRows[0]?.message?.tool_call_id, "call_top_level_1");
    assert.equal(toolRows[0]?.message?.name, "eval");

    /*
     * And nothing in the journal carries a bare-numeric tool_call_id, which is
     * the signature of a leaked inner call: Code Mode numbers its calls, the
     * model's provider ids never look like that.
     */
    const numericIds = rows
      .filter((row) => typeof row.message?.tool_call_id === "string")
      .map((row) => row.message!.tool_call_id!)
      .filter((id) => /^\d+$/.test(id));
    assert.deepEqual(numericIds, [], "no inner call id may reach the journal as a top-level tool message");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an eval that fails still journals only its own row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-eval-journal-fail-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    const runId = `eval-journal-fail-${Date.now()}`;
    const executor = new ToolExecutor({
      workspaceRoot: root,
      runId,
      sessionId: runId,
      traceId: runId,
      logLevel: "info",
      safetyProfile: "allow_all",
      trajectoryLogger: new TrajectoryLogger(root, { runId }),
    });

    // A tool call that is refused, then a throw. The inner call still ran
    // through the executor, so it is still the case that must not leak.
    await executor.execute({
      id: "call_top_level_2",
      name: "eval",
      args: { code: `try { await tools.file_view({ path: "../../etc/passwd" }); } catch (e) { void e; }\nthrow new Error('after the inner call');` },
    });

    const rows = await readJournal(root, runId);
    const toolRows = rows.filter((row) => row.kind === "entry" && row.message?.role === "tool");
    assert.equal(toolRows.length, 1);
    assert.equal(toolRows[0]?.message?.tool_call_id, "call_top_level_2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
