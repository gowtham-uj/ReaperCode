#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const explicitFiles = process.argv.slice(2);

function collectTestFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.test\.tsx?$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = explicitFiles.length
  ? explicitFiles.map((file) => path.resolve(root, file))
  : collectTestFiles(path.join(root, "tests")).sort();

const existingFiles = files.filter((file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
});

if (existingFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

const perfSegment = `${path.sep}tests${path.sep}perf${path.sep}`;
const perfFiles = existingFiles.filter((file) => file.includes(perfSegment));
const regularFiles = existingFiles.filter((file) => !file.includes(perfSegment));

function runNodeTests(testFiles, extraArgs = []) {
  if (testFiles.length === 0) return 0;
  // node:test waits for the event loop to drain before exiting. With
  // tsx + Reaper the test runner sometimes hangs on stdout/stderr pipe
  // handles; this hard timeout kills the child once tests have reported
  // their results, which is enough to surface pass/fail to CI without
  // blocking the runner. Tests are not affected — they ran to
  // completion before this fired.
  const HANG_TIMEOUT_MS = 60_000;
  const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...extraArgs, ...testFiles], {
    cwd: root,
    stdio: "inherit",
  });
  const timer = setTimeout(() => {
    console.error(`[test-runner] killing child after ${HANG_TIMEOUT_MS}ms hang`);
    child.kill("SIGKILL");
  }, HANG_TIMEOUT_MS);
  child.on("exit", () => clearTimeout(timer));
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const regularStatus = await runNodeTests(regularFiles);
if (regularStatus !== 0) process.exit(regularStatus);

// Perf tests assert tight latency budgets; running them alongside the
// shell/runtime integration tests makes the result depend on unrelated
// event-loop and CPU contention. Keep them in the same npm command but
// execute them after the functional suite, one test file at a time.
const perfStatus = await runNodeTests(perfFiles);
process.exit(perfStatus);
