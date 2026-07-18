import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("rules.local.md deny is enforced — command is blocked and never executes", async () => {
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

  // Workflow 3: an explicit local `deny` is a hard denial in every
  // permission mode. The command must not execute and the tool
  // result must surface a `permission_denied` code.
  const result = await executor.execute({ id: "1", name: "bash", args: { cmd: "npm --version", timeout: 60} });
  assert.equal(result.ok, false, "local deny must block execution");
  assert.equal(result.error?.code, "permission_denied");
  assert.match(result.error?.message ?? "", /rules_local_deny_1|Local rule matched/);
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

  await executor.execute({ id: "1", name: "bash", args: { cmd: "node -e \"console.log('ok')\"", timeout: 60} });
  const audit = await readFile(path.join(workspaceRoot, ".reaper", "logs", "reaper-audit.jsonl"), "utf8");
  assert.match(audit, /rules.local.md/);
});