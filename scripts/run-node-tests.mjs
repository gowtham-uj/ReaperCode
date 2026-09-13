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
  /*
   * The watchdog measures silence, not elapsed time.
   *
   * It used to be a wall-clock kill, and that was simply wrong: the regular
   * suite reports `duration_ms 578050` on a healthy machine, so a 600s timer
   * left 22 seconds of margin and killed green runs as soon as anything made
   * the suite a little slower. Two runs did exactly that — one stopping 1475
   * tests in, one 1189 — and both read like hangs in the log because a kill
   * and a hang leave the same trace: output, then nothing.
   *
   * Elapsed time cannot separate "stuck" from "slow". Silence can. A working
   * run emits test lines continuously; a stuck one emits nothing at all. So
   * the timer resets on every chunk of child output, and a genuinely wedged
   * child still dies — including the leaked-handle case where node:test
   * prints its summary and then waits forever.
   *
   * `REAPER_TEST_HANG_TIMEOUT_MS` now means seconds of *silence* tolerated.
   */
  const configuredTimeout = Number(process.env.REAPER_TEST_HANG_TIMEOUT_MS);
  const HANG_TIMEOUT_MS =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 10 * 60_000;
  const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...extraArgs, ...testFiles], {
    cwd: root,
    /*
     * Piped rather than inherited so the parent can watch for output and
     * restart the silence timer. Forwarded verbatim below, so the run still
     * streams live and the captured log is unchanged.
     *
     * `detached` puts the child in its own process group, which is what makes
     * the kill below reach the whole tree. Without it the kill lands on the
     * runner and the grandchild survives: node runs each test file with
     * `--test-isolation=process`, and SIGKILLing the runner leaves no one to
     * reap them. Verified by hanging a test on purpose — the runner reported
     * exit, and a `node --import tsx <that test file>` was still alive and
     * still holding the file minutes later.
     */
    stdio: ["inherit", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      /*
       * The transport retry ladder sleeps 1s + 3s + 9s before it gives up, and
       * three tests deliberately drive it to exhaustion — thirteen seconds of
       * sleeping each, thirty-nine seconds of the suite spent waiting for
       * nothing, which is also what pushed the whole run close enough to the
       * ten-minute hang watchdog to be killed by it.
       *
       * Setting this to 0 removes the waiting and nothing else: same number of
       * attempts, same classification, same blocker, same transcript. The
       * ladder's behaviour under a real provider is unchanged because nothing
       * in the app sets this.
       */
      REAPER_TRANSPORT_RETRY_BACKOFF_MS: "0",
    },
  });
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.error(
        `[test-runner] killing child after ${HANG_TIMEOUT_MS}ms of silence `
        + "(no test output, so it is wedged rather than slow)",
      );
      /*
       * Negative pid means "the whole group", so the per-file process children
       * die with the runner. Guarded because the group is gone on Windows and
       * on any platform that never got one; falling back to the child alone is
       * strictly better than throwing inside a watchdog.
       */
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, HANG_TIMEOUT_MS);
  };
  // Each pipe resets the timer from its own data event. The chunk is written
  // through untouched, so a passing run prints exactly what it used to.
  const watch = (stream, sink) => {
    stream.on("data", (chunk) => {
      arm();
      sink.write(chunk);
    });
  };
  watch(child.stdout, process.stdout);
  watch(child.stderr, process.stderr);
  arm();
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
