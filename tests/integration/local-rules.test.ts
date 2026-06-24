import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("rules.local.md can deny a shell command", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "rules.local.md"), "- deny: npm\\s+--version\n", "utf8");
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });

  const result = await executor.execute({ id: "1", name: "run_shell_command", args: { cmd: "npm --version" } });
  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Local rule matched/);
});

test("rules.local.md loading is audited with hash provenance", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "rules.local.md"), "- allow: node\\s+-e\n", "utf8");
  const executor = new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });

  await executor.execute({ id: "1", name: "run_shell_command", args: { cmd: "node -e \"console.log('ok')\"" } });
  const audit = await readFile(path.join(workspaceRoot, ".reaper", "logs", "reaper-audit.jsonl"), "utf8");
  assert.match(audit, /rules.local.md/);
});
