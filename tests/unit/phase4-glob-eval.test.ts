import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeGlob } from "../../src/tools/glob.js";

/** Phase 4: glob finds .ts files */
test("Phase 4: glob finds TypeScript files", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-glob-"));
  try {
    await mkdir(path.join(workspaceRoot, "src", "tools"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "src", "tools", "a.ts"), "");
    await writeFile(path.join(workspaceRoot, "src", "tools", "b.ts"), "");
    await writeFile(path.join(workspaceRoot, "src", "tools", "c.js"), "");

    const result = await executeGlob("src/tools/*.ts", workspaceRoot);
    assert.equal(result.count, 2);
    assert.ok(result.files.some((f) => f.relativePath.includes("a.ts")));
    assert.ok(result.files.some((f) => f.relativePath.includes("b.ts")));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

/** Phase 4: glob finds .md files recursively */
test("Phase 4: glob finds markdown files recursively", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reaper-glob-md-"));
  try {
    await mkdir(path.join(workspaceRoot, "docs", "dev"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "README.md"), "");
    await writeFile(path.join(workspaceRoot, "docs", "guide.md"), "");
    await writeFile(path.join(workspaceRoot, "docs", "dev", "plan.md"), "");

    const result = await executeGlob("**/*.md", workspaceRoot);
    assert.ok(result.count >= 3, `should find at least 3 .md files, got ${result.count}`);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  }
});

// The three `eval` cases that lived here tested the old `node -e` / `python -c`
// implementation, which no longer exists. Code Mode's coverage lives in
// `tests/unit/code-mode.test.ts`; `glob` keeps its cases here.
