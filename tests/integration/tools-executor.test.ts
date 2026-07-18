import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

  assert.equal(result.ok, true, JSON.stringify(result.error));
  const content = await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8");
  assert.match(content, /value = 99/);
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

  // Pi-style: the executor no longer refuses edits to files that have changed
  // since the last read; the model is responsible for re-reading if needed.
  assert.equal(result.ok, true);
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

test("bash executes real shell commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { timeout: 60, cmd: "node -e \"console.log('shell-ok')\"" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /shell-ok/);
});

test("bash does not leak Node test-runner context", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { timeout: 60, cmd: "node -e \"console.log(process.env.NODE_TEST_CONTEXT || 'clean')\"" },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /^clean/);
});

test("bash reports timeouts cleanly", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { cmd: "node -e \"setTimeout(() => {}, 2000)\"", timeout: 1 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /timed out/);
});

test("bash blocks repo-root escapes from nested task workspaces", async () => {
  const workspaceRoot = path.join(process.cwd(), ".reaper-test-shell-boundary", `task-${Date.now()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const executor = await createExecutor(workspaceRoot);

  try {
    const cdResult = await executor.execute({
      id: "escape-cd",
      name: "bash",
      args: { cmd: "cd /workspace && npm init -y", timeout: 60 },
    });
    assert.equal(cdResult.ok, false);
    assert.equal(cdResult.error?.code, "path_escape");

    // Use an absolute path under the repository root but outside the task
    // workspace. This must be caught deterministically regardless of whether
    // the target happens to be writable.
    const repoRootEscapeTarget = path.join(process.cwd(), "reaper-shell-escape-test");
    const absolutePathResult = await executor.execute({
      id: "escape-path",
      name: "bash",
      args: { cmd: `mkdir -p ${repoRootEscapeTarget}`, timeout: 60 },
    });
    assert.equal(absolutePathResult.ok, false);
    assert.equal(absolutePathResult.error?.code, "path_escape");
  } finally {
    await rm(path.join(process.cwd(), ".reaper-test-shell-boundary"), { recursive: true, force: true });
  }
});

test("bash propagates pipefail exit code for piped verification commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "pipe-fail",
    name: "bash",
    args: { cmd: "(echo fail; exit 1) | head -1", timeout: 60 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /(?:[Ee]xit|[Ee]xited with)\s+(?:code\s*[:=]?\s*)?1/);
});

test("bash tracks chained cd commands within the workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "chained-cd",
    name: "bash",
    args: { cmd: "mkdir -p client server && cd client && cd ../server && pwd", timeout: 60 },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /\/server/);
});

test("bash does not auto-background ordinary node scripts", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "test-script.js"), "console.log('script-complete');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "node-script",
    name: "bash",
    args: { cmd: "node server/test-script.js", timeout: 60 },
  });

  assert.equal(result.ok, true);
  assert.match(String((result.output as { stdout: string }).stdout), /script-complete/);
  assert.equal("pid" in ((result.output as Record<string, unknown>) ?? {}), false);
});

test("bash rejects bare interactive node commands", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bare-node",
    name: "bash",
    args: { cmd: "node", timeout: 60 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Interactive shell commands are disabled/);
});

test("bash reports immediate background startup failures", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "package.json"), "", "utf8");
  await writeFile(path.join(workspaceRoot, "server", "index.js"), "console.log('should not start');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bad-server",
    name: "bash",
    args: { cmd: "node server/index.js", timeout: 60 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /SyntaxError: Error parsing|ERR_INVALID_PACKAGE_CONFIG/);
});

test("bash explains module path failures without language-specific repair policy", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "server"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "server", "bad-require.js"), "require('./server/models/Task');\n", "utf8");
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "bad-require",
    name: "bash",
    args: { cmd: "node server/bad-require.js", timeout: 60 },
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
    name: "bash",
    args: { timeout: 60, cmd: "node -e \"console.log('server-ready'); setInterval(() => {}, 1000)\"", run_in_background: true },
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

test("bash preserves the user command exit code after metadata capture", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { cmd: "printf 'before-fail\\n'; exit 7", timeout: 60 },
  });

  assert.equal(result.ok, false);
  assert.match(result.error?.message ?? "", /Command exited with code 7/);
  assert.match(result.error?.message ?? "", /before-fail/);
});

test("bash prefers the project-local virtual environment when present", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, ".venv", "bin"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".venv", "bin", "python"), "#!/usr/bin/env bash\nprintf 'venv-python'\n", { encoding: "utf8", mode: 0o755 });
  await chmod(path.join(workspaceRoot, ".venv", "bin", "python"), 0o755);
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "bash",
    args: { timeout: 60, cmd: "printf '%s' \"$PATH\"" },
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

test("bash exposes scratchpad dependency cache env vars", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "env",
    name: "bash",
    args: { timeout: 60, cmd: "node -e \"console.log(process.env.REAPER_SCRATCHPAD); console.log(process.env.NPM_CONFIG_CACHE); console.log(process.env.WORKSPACE)\"" },
  });

  assert.equal(result.ok, true);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.match(stdout, /\.reaper/);
  assert.match(stdout, /cache\/npm/);
  assert.match(stdout, new RegExp(escapeRegExp(workspaceRoot.replace(/\\/g, "/"))));
});

test("bash flags vulnerable dependency output as quality warning", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "quality",
    name: "bash",
    args: { cmd: "printf '1 critical vulnerability\\nnpm warn deprecated old-package\\n'", timeout: 60 },
  });

  assert.equal(result.ok, true);
  const stdout = String((result.output as { stdout: string }).stdout);
  assert.match(stdout, /REAPER DEPENDENCY QUALITY WARNINGS/);
  assert.match(stdout, /vulnerabilities/);
  assert.match(stdout, /deprecated/);
});

test("bash does not flag zero vulnerabilities as quality warning", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "quality-zero",
    name: "bash",
    args: { cmd: "printf 'found 0 vulnerabilities\\n'", timeout: 60 },
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
    name: "bash",
    args: { cmd: "git push --force origin main || true", timeout: 60 },
  });

  assert.equal(result.ok, true);
  const auditLog = await readFile(path.join(getReaperScratchpadPaths(workspaceRoot).logs, "reaper-audit.jsonl"), "utf8");
  assert.match(auditLog, /would_block/);
});

test("replace_in_file edits files that were never read by the executor", async () => {
  // Regression: the redundant safe-edit guard used to require the
  // model to pre-read a file before editing it. The guard has been
  // removed; replace_in_file must succeed against a file that the
  // executor has never touched. Combined with the source-level test
  // below, this proves the duplicate read-then-apply path is gone.
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  const target = path.join(workspaceRoot, "src", "untouched.txt");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

  const replaceResult = await executor.execute({
    id: "1",
    name: "replace_in_file",
    args: { path: "src/untouched.txt", oldString: "beta", newString: "BETA" },
  });
  assert.equal(replaceResult.ok, true);

  const afterReplace = await readFile(target, "utf8");
  assert.equal(afterReplace, "alpha\nBETA\ngamma\n");
});

test("replace_in_file performs no redundant candidate-content read", async () => {
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);
  const target = path.join(workspaceRoot, "src", "single-read.txt");
  await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

  const originalReadFile = fs.promises.readFile;
  let targetReads = 0;
  fs.promises.readFile = (async (file: unknown, ...args: unknown[]) => {
    if (path.resolve(String(file)) === target) targetReads += 1;
    return Reflect.apply(originalReadFile, fs.promises, [file, ...args]);
  }) as typeof fs.promises.readFile;
  syncBuiltinESMExports();

  try {
    const result = await executor.execute({
      id: "single-read",
      name: "replace_in_file",
      args: { path: "src/single-read.txt", oldString: "beta", newString: "BETA" },
    });

    assert.equal(result.ok, true);
    assert.equal(targetReads, 2, "expected one snapshot read and one authoritative mutation read");
  } finally {
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }

  assert.equal(await readFile(target, "utf8"), "alpha\nBETA\ngamma\n");
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
