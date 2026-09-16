/**
 * Diagnostics must read the workspace the model has already changed, not the
 * one last flushed to disk.
 *
 * The reported failure: inside a single `eval` script, `edit_file` inserted a
 * type error and the very next `diagnostics(tsc)` answered `ok: true,
 * diagnostics: []`. The real `TS2322` only appeared in the *next* eval, after
 * the write had flushed at the turn's barrier. A clean bill of health from a
 * stale read is worse than no answer, because the model believes it and moves
 * on.
 *
 * The cause is that writes are staged in the write-ahead log and reach disk
 * only at a barrier, while `diagnostics` shells out to a real tool that reads
 * the filesystem. Between two statements of one script there is no barrier, so
 * tsc saw the pre-edit file. The fix flushes staged writes before diagnostics
 * runs; this test drives that path and asserts tsc sees the error.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { RecoverySession } from "../../src/recovery/session.js";

async function fixture(): Promise<{ root: string; executor: ToolExecutor; recovery: RecoverySession; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-diag-pending-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "typed.ts"),
    "export const value: number = 1;\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ["src"] }, null, 2),
    "utf8",
  );
  const runId = `diag-${Date.now()}`;
  const recoverySession = new RecoverySession({
    workspaceRoot: root,
    runId,
    sessionId: runId,
    traceId: runId,
    logLevel: "info",
  });
  const executor = new ToolExecutor({
    workspaceRoot: root,
    runId,
    sessionId: runId,
    traceId: runId,
    logLevel: "info",
    safetyProfile: "allow_all",
    recoverySession,
  });
  return {
    root,
    executor,
    recovery: recoverySession,
    cleanup: async () => {
      try {
        await executor.cleanupBackgroundProcesses("test");
      } catch {
        /* ignore */
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("diagnostics sees a write staged earlier in the same eval script", async () => {
  const { root, executor, cleanup } = await fixture();
  try {
    /*
     * The script reproduces the exact sequence from the audit: edit a file to
     * introduce a type error, then ask for diagnostics in the same script. The
     * script returns the diagnostics verdict so the assertion is about what the
     * model would have been told, not about disk state after the fact.
     */
    const result = await executor.execute({
      id: "eval-1",
      name: "eval",
      args: {
        code: `
const edited = await tools.edit_file({ path: "src/typed.ts", edits: [{ oldString: "export const value: number = 1;", newString: "export const value: number = 'not a number';" }] });
const diag = await tools.diagnostics({ path: "src/typed.ts", kind: "tsc" });
({ edited, diag });
`,
      },
    });
    assert.equal(result.ok, true, `eval failed: ${JSON.stringify(result.error ?? {})}`);
    const value = (result.output as { value?: { edited?: unknown; diag?: { ok?: boolean; diagnostics?: Array<string | { message: string }> } } }).value;
    assert.ok(value, "the script must produce a value");

    /*
     * The point: the diagnostics report must reflect the edit. Before the fix
     * this was `ok: true` with no diagnostics, because tsc read the file as it
     * was on disk before the staged write flushed.
     */
    const diag = value!.diag;
    assert.equal(diag?.ok, false, `diagnostics reported clean for a file with a type error: ${JSON.stringify(diag)}`);
    /*
     * The entry is an object, not a string: `{ severity, message, line, column }`.
     * The check is on the message, which is where the code and the explanation
     * live.
     */
    assert.ok(
      (diag?.diagnostics ?? []).some((entry) => /TS2322/.test(typeof entry === "string" ? entry : entry.message)),
      `expected a TS2322 in the diagnostics, got: ${JSON.stringify(diag?.diagnostics)}`,
    );
  } finally {
    await cleanup();
  }
});

test("the staged edit reaches disk at the next barrier flush", async () => {
  const { root, executor, recovery, cleanup } = await fixture();
  try {
    await executor.execute({
      id: "eval-1",
      name: "eval",
      args: {
        code: `await tools.edit_file({ path: "src/typed.ts", edits: [{ oldString: "export const value: number = 1;", newString: "export const value = 42;" }] }); 'done';`,
      },
    });
    /*
     * Staged, not written: the durability boundary is the barrier, and between
     * two statements of a script there is not one. Flushing is what the
     * scheduler does at an island boundary and what the turn does at its end,
     * so this asserts the write survives that step rather than pretending it
     * was already durable.
     */
    assert.equal(recovery.hasPendingWrites(), true, "the edit should still be staged");
    await recovery.flushForBarrier();
    const content = await readFile(path.join(root, "src", "typed.ts"), "utf8");
    assert.match(content, /export const value = 42;/);
  } finally {
    await cleanup();
  }
});
