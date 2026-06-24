import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { ToolExecutor } from "../../src/tools/executor.js";
import { getReaperScratchpadPaths } from "../../src/workspace/scratchpad.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

async function createExecutor(workspaceRoot: string) {
  return new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

test("read_file reads actual workspace content", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "read_file",
    args: { path: "README.md" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { content: string }).content), /Temp Workspace/);
});

test("view_file reads a bounded file window", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "view-1",
    name: "view_file",
    args: { path: "src/app.ts", startLine: 1, endLine: 1 },
  });

  assert.equal(result.ok, true);
  assert.equal((result.output as { startLine: number; endLine: number }).startLine, 1);
  assert.equal((result.output as { startLine: number; endLine: number }).endLine, 1);
  assert.match(String((result.output as { content: string }).content), /^1: /);
});

test("list_directory lists actual entries", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "list_directory",
    args: { path: "." },
  });

  assert.equal(result.ok, true);
  assert.deepEqual((result.output as { entries: string[] }).entries, ["package.json", "README.md", "src/"]);
});

test("grep_search finds real matches in files", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "grep_search",
    args: { pattern: "answer", path: "src" },
  });

  assert.equal(result.ok, true);
  assert.equal((result.output as { matches: Array<{ line: number }> }).matches[0]?.line, 1);
});

test("write_file writes to disk", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "write_file",
    args: { path: "src/new.ts", content: "export const created = true;\n" },
  });

  assert.equal(result.ok, true);
  const content = await readFile(path.join(workspaceRoot, "src", "new.ts"), "utf8");
  assert.match(content, /created = true/);
});

test("write_file rejects invalid source before writing", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bad-python",
    name: "write_file",
    args: { path: "src/bad.py", content: "def broken(:\n    pass\n" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "editor_guard_rejected");
  await assert.rejects(() => readFile(path.join(workspaceRoot, "src", "bad.py"), "utf8"));
});

test("write_file reports directory targets without EISDIR freshness crashes", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "src", "generated.py"), { recursive: true });
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "directory-target",
    name: "write_file",
    args: { path: "src/generated.py", content: "print('ok')\n" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /is a directory/i);
  assert.doesNotMatch(result.error?.message ?? "", /EISDIR/i);
});

test("replace_in_file updates file content on disk", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({
    id: "read-first",
    name: "read_file",
    args: { path: "src/app.ts" },
  });
  const result = await executor.execute({
    id: "1",
    name: "replace_in_file",
    args: { path: "src/app.ts", oldString: "41", newString: "42" },
  });

  assert.equal(result.ok, true);
  const content = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(content, /42/);
});

test("replace_in_file rejects invalid candidate content before mutating", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({
    id: "read-first",
    name: "read_file",
    args: { path: "src/app.ts" },
  });
  const result = await executor.execute({
    id: "bad-replace",
    name: "replace_in_file",
    args: { path: "src/app.ts", oldString: "41", newString: "" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "editor_guard_rejected");
  const content = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(content, /41/);
});

test("replace_in_file supports line-range replacement", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({
    id: "read-first",
    name: "read_file",
    args: { path: "src/app.ts" },
  });
  const result = await executor.execute({
    id: "1",
    name: "replace_in_file",
    args: { path: "src/app.ts", startLine: 1, endLine: 1, content: "export const value = 99;" },
  });

  assert.equal(result.ok, true);
  const content = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(content, /value = 99/);
});

test("delete_file removes the target file", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({
    id: "read-first",
    name: "read_file",
    args: { path: "src/app.ts" },
  });
  const result = await executor.execute({
    id: "1",
    name: "delete_file",
    args: { path: "src/app.ts" },
  });

  assert.equal(result.ok, true);
  await assert.rejects(() => readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8"));
});

test("write tools refuse to mutate existing files before a fresh read", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "unsafe-write",
    name: "write_file",
    args: { path: "src/app.ts", content: "export const answer = 42;\n" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /before reading it/);
});

test("stale write-before-read failures are machine-classified for graph repair", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "stale-write",
    name: "write_file",
    args: { path: "src/app.ts", content: "export const answer = 42;\n" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "stale_write_requires_read");
});

test("write tools refuse stale edits after a file changes since read", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({ id: "read", name: "read_file", args: { path: "src/app.ts" } });
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const answer = 99;\n", "utf8");

  const result = await executor.execute({
    id: "stale-edit",
    name: "replace_in_file",
    args: { path: "src/app.ts", oldString: "99", newString: "42" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /changed since it was last read/);
});

test("write tools snapshot existing files before mutation", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  await executor.execute({ id: "read", name: "read_file", args: { path: "src/app.ts" } });
  const result = await executor.execute({
    id: "edit",
    name: "replace_in_file",
    args: { path: "src/app.ts", oldString: "41", newString: "42" },
  });

  assert.equal(result.ok, true);
  const snapshotsRoot = path.join(getReaperScratchpadPaths(workspaceRoot).artifacts, "file-snapshots");
  const files = await listFiles(snapshotsRoot);
  assert.equal(files.some((file) => file.endsWith(path.join("src", "app.ts"))), true);
  assert.equal(files.some((file) => file.endsWith(path.join("src", "app.ts.meta.json"))), true);
});

test("run_shell_command executes real shell commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "node -e \"console.log('shell-ok')\"" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /shell-ok/);
});

test("run_shell_command does not leak Node test-runner context", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "node -e \"console.log(process.env.NODE_TEST_CONTEXT || 'clean')\"" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /^clean/);
});

test("run_shell_command reports timeouts cleanly", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "node -e \"setTimeout(() => {}, 500)\"", timeoutMs: 20 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /timed out/);
});

test("run_shell_command rejects shell job-control backgrounding", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "job-control",
    name: "run_shell_command",
    args: { cmd: "node -e \"setInterval(() => {}, 1000)\" & sleep 1 && kill %1" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /job-control backgrounding is disabled/);
});

test("run_shell_command blocks repo-root escapes from nested task workspaces", async () => {
  const workspaceRoot = path.join(process.cwd(), ".reaper-test-shell-boundary", `task-${Date.now()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const executor = await createExecutor(workspaceRoot);

  try {
    const cdResult = await executor.execute({
      id: "escape-cd",
      name: "run_shell_command",
      args: { cmd: "cd /workspace && npm init -y" },
    });
    assert.equal(cdResult.ok, false);
    assert.equal(cdResult.error?.code, "path_escape");

    const absolutePathResult = await executor.execute({
      id: "escape-path",
      name: "run_shell_command",
      args: { cmd: "mkdir -p /workspace/server" },
    });
    assert.equal(absolutePathResult.ok, false);
    assert.equal(absolutePathResult.error?.code, "path_escape");
  } finally {
    await rm(path.join(process.cwd(), ".reaper-test-shell-boundary"), { recursive: true, force: true });
  }
});

test("run_shell_command tracks chained cd commands within the workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "chained-cd",
    name: "run_shell_command",
    args: { cmd: "mkdir -p client server && cd client && cd ../server && pwd" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /\/server/);
});

test("run_shell_command does not auto-background ordinary node scripts", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "test-script.js"), "console.log('script-complete');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "node-script",
    name: "run_shell_command",
    args: { cmd: "node server/test-script.js" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /script-complete/);
  assert.equal("pid" in ((result.output as Record<string, unknown>) ?? {}), false);
});

test("run_shell_command rejects bare interactive node commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bare-node",
    name: "run_shell_command",
    args: { cmd: "node" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Interactive shell commands are disabled/);
});

test("run_shell_command reports immediate background startup failures", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "package.json"), "", "utf8");
  await writeFile(path.join(workspaceRoot, "server", "index.js"), "console.log('should not start');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bad-server",
    name: "run_shell_command",
    args: { cmd: "node server/index.js" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /SyntaxError: Error parsing|ERR_INVALID_PACKAGE_CONFIG/);
});

test("run_shell_command explains module path failures without language-specific repair policy", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "bad-require.js"), "require('./server/models/Task');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bad-require",
    name: "run_shell_command",
    args: { cmd: "node server/bad-require.js" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Import\/module path resolution is runtime-specific/);
  assert.match(result.error?.message ?? "", /Do not repeat the same failing import path unchanged/);
});

test("background shell processes are logged and cleaned as process groups", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const start = await executor.execute({
    id: "bg",
    name: "run_shell_command",
    args: { cmd: "node -e \"console.log('server-ready'); setInterval(() => {}, 1000)\"", isBackground: true },
  });

  assert.equal(start.ok, true);
  const startOutput = start.output as { pid: number; logPath: string };
  assert.equal(typeof startOutput.pid, "number");
  assert.match(startOutput.logPath, /\.reaper\/runs\/run-1\/artifacts\/processes\/bg\.log$/);

  const read = await executor.execute({
    id: "read-bg",
    name: "read_background_output",
    args: { pid: startOutput.pid, waitForMatch: "server-ready", lines: 10 },
  });
  assert.equal(read.ok, true);
  assert.match(String((read.output as { output: string }).output), /server-ready/);

  await executor.cleanupBackgroundProcesses("test-cleanup");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(startOutput.pid, 0));

  const log = await readFile(startOutput.logPath, "utf8");
  assert.match(log, /server-ready/);
  assert.match(log, /test-cleanup/);
});

test("run_shell_command preserves the user command exit code after metadata capture", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "printf 'before-fail\\n'; exit 7" },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Command exited with code 7/);
  assert.match(result.error?.message ?? "", /before-fail/);
});

test("run_shell_command prefers the project-local virtual environment when present", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".venv", "bin", "python"), "#!/usr/bin/env bash\nprintf 'venv-python'\n", { encoding: "utf8", mode: 0o755 });
  await chmod(path.join(workspaceRoot, ".venv", "bin", "python"), 0o755);
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "printf '%s' \"$PATH\"" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /\.venv\/bin/);
});

test("inspect_environment reports scratchpad and dependency state", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "inspect",
    name: "inspect_environment",
    args: {},
  });

  assert.equal(result.ok, true);
  const output = result.output as {
    scratchpad: { root: string; cache: string; dependencies: string };
    manifests: Array<{ path: string; kind: string }>;
    dependencyState: Array<Record<string, unknown>>;
  };
  assert.match(output.scratchpad.root, /\.reaper$/);
  assert.ok(output.scratchpad.cache.includes(".reaper"));
  assert.deepEqual(output.manifests.some((item) => item.path === "package.json" && item.kind === "node"), true);
  assert.deepEqual(output.dependencyState.some((item) => item.manifest === "package.json" && item.nodeModules === false), true);
});

test("run_shell_command exposes scratchpad dependency cache env vars", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "env",
    name: "run_shell_command",
    args: { cmd: "node -e \"console.log(process.env.REAPER_SCRATCHPAD); console.log(process.env.NPM_CONFIG_CACHE); console.log(process.env.WORKSPACE)\"" },
  });

  assert.equal(result.ok, true);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.match(stdout, /\.reaper/);
  assert.match(stdout, /cache\/npm/);
  assert.match(stdout, new RegExp(escapeRegExp(workspaceRoot)));
});

test("run_shell_command flags vulnerable dependency output as quality warning", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "quality",
    name: "run_shell_command",
    args: { cmd: "printf '1 critical vulnerability\\nnpm warn deprecated old-package\\n'" },
  });

  assert.equal(result.ok, true);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.match(stdout, /REAPER DEPENDENCY QUALITY WARNINGS/);
  assert.match(stdout, /vulnerabilities/);
  assert.match(stdout, /deprecated/);
});

test("run_shell_command does not flag zero vulnerabilities as quality warning", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "quality-zero",
    name: "run_shell_command",
    args: { cmd: "printf 'found 0 vulnerabilities\\n'" },
  });

  assert.equal(result.ok, true);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.doesNotMatch(stdout, /REAPER DEPENDENCY QUALITY WARNINGS/);
});

test("path escapes are blocked and audited", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "read_file",
    args: { path: "../outside.txt" },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "path_escape");
});

test("standard command rules are logged as would-block in allow-all mode", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "run_shell_command",
    args: { cmd: "git push --force origin main || true" },
  });

  assert.equal(result.ok, true);
  const auditLog = await readFile(path.join(getReaperScratchpadPaths(workspaceRoot).logs, "reaper-audit.jsonl"), "utf8");
  assert.match(auditLog, /would_block/);
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(root, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    }),
  );
  return nested.flat();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
