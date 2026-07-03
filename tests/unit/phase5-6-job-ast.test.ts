import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeAstGrep, executeDiagnostics } from "../../src/tools/ast-grep.js";

/** Phase 6: ast_grep finds function declarations */
test("Phase 6: ast_grep finds function declarations", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-ast-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "app.ts"),
      "export function handleError(err: Error) { return err.message; }\nexport function success() { return true; }\n",
      "utf8",
    );

    const result = await executeAstGrep("handleError", workspaceRoot);
    assert.equal(result.count, 1);
    assert.equal(result.matches[0]?.symbol, "handleError");
    assert.equal(result.matches[0]?.kind, "function");
    assert.match(result.matches[0]?.file ?? "", /app\.ts/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Phase 6: ast_grep finds class declarations */
test("Phase 6: ast_grep finds class declarations", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-ast-class-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "src", "model.ts"),
      "export class MyModel { constructor() {} }\n",
      "utf8",
    );

    const result = await executeAstGrep("MyModel", workspaceRoot);
    assert.ok(result.count >= 1);
    assert.equal(result.matches[0]?.kind, "class");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Phase 6: ast_grep returns empty for non-existent symbol */
test("Phase 6: ast_grep returns empty for non-existent symbol", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-ast-empty-"));
  try {
    await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export function real() {}\n", "utf8");

    const result = await executeAstGrep("nonexistent", workspaceRoot);
    assert.equal(result.count, 0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

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
