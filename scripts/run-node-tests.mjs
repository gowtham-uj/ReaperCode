#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...extraArgs, ...testFiles], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status ?? 1;
}

const regularStatus = runNodeTests(regularFiles);
if (regularStatus !== 0) process.exit(regularStatus);

// Perf tests assert tight latency budgets; running them alongside the
// shell/runtime integration tests makes the result depend on unrelated
// event-loop and CPU contention. Keep them in the same npm command but
// execute them after the functional suite, one test file at a time.
const perfStatus = runNodeTests(perfFiles);
process.exit(perfStatus);
