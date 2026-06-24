import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { writePlanMarkdown } from "../../src/runtime/prompt-builders.js";

test("writePlanMarkdown writes a human-readable PLAN.md to .reaper/PLAN.md", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "reaper-plan-"));
  try {
    const plan = [
      { id: "step-1", title: "Inspect workspace", type: "inspect", instructions: "ls and read README" },
      { id: "step-2", title: "Scaffold backend", type: "command", instructions: "create server.ts", suggestedImplementation: "use Express", successCriteria: ["server.ts exists"] },
    ];
    await writePlanMarkdown(ws, plan, {
      currentStepIndex: 1,
      completedStepIds: ["step-1"],
      failed: false,
    });
    const md = await readFile(path.join(ws, ".reaper", "PLAN.md"), "utf8");
    assert.match(md, /# Reaper Plan/);
    assert.match(md, /Run 1\/2 complete/);
    assert.match(md, /\[x\] 1\. Inspect workspace/);
    assert.match(md, /\[>\] 2\. Scaffold backend/);
    assert.match(md, /step-1/);
    assert.match(md, /ls and read README/);
    assert.match(md, /Express/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("writePlanMarkdown marks failed runs", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "reaper-plan-"));
  try {
    await writePlanMarkdown(
      ws,
      [{ id: "s1", title: "Do thing", type: "command", instructions: "do it" }],
      { currentStepIndex: 0, completedStepIds: [], failed: true },
    );
    const md = await readFile(path.join(ws, ".reaper", "PLAN.md"), "utf8");
    assert.match(md, /\(run failed\)/);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("writePlanMarkdown is a no-op for empty plans", async () => {
  const ws = await mkdtemp(path.join(tmpdir(), "reaper-plan-"));
  try {
    await writePlanMarkdown(ws, [], { currentStepIndex: 0, completedStepIds: [], failed: false });
    await writePlanMarkdown(ws, null as unknown as unknown[], { currentStepIndex: 0, completedStepIds: [], failed: false });
    // No PLAN.md should exist (file system unchanged from mkdtemp)
    let exists = false;
    try {
      await readFile(path.join(ws, ".reaper", "PLAN.md"), "utf8");
      exists = true;
    } catch {
      // expected
    }
    assert.equal(exists, false);
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});