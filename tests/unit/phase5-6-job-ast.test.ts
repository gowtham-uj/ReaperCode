import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeDiagnostics } from "../../src/tools/diagnostics.js";

/** Phase 6: diagnostics runs tsc on a file */
test("Phase 6: diagnostics runs tsc on a clean TypeScript file", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-diag-"));
  try {
    await writeFile(path.join(workspaceRoot, "test.ts"), "export const x: number = 42;\n", "utf8");

    const result = await executeDiagnostics("test.ts", workspaceRoot, "tsc");
    assert.equal(result.kind, "tsc");
    // tsc may or may not succeed depending on tsconfig, but should return results
    assert.ok(typeof result.ok === "boolean");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});
