/**
 * An error that escapes a run must not kill the process.
 *
 * This is the failure that took the live stack down during a mission: a
 * `downloadAfter` call timed out, the promise carrying that timeout had no
 * handler at the moment it rejected, and the crash handler exited the process.
 * The gateway went with it, the UI went to "reconnecting", every thread vanished
 * from the sidebar, and the mission kept printing healthy numbers because its
 * two gauges read the browser's CDP port directly and never noticed the agent was
 * gone. The browser and its ten tabs were untouched the whole time.
 *
 * The rule these tests pin: a failure with a run scope on the stack is confined
 * to that run; only a failure belonging to no run ends the process. The scope is
 * visible from the handler, which is what makes the attribution possible, and it
 * is verified rather than assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Three levels up from tests/unit/runtime/ lands on the repo root. Counted
 * rather than guessed: URL resolution drops the base file's last segment, so
 * `../../../` from `.../tests/unit/runtime/this-file.ts` is `.../`, and one more
 * would clamp at the filesystem root.
 */
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Run a snippet in a child process and report what it printed.
 *
 * A child is required and not incidental: the behaviour under test is whether
 * `process.exit` is called, and a parent process cannot observe that about
 * itself. `installCrashHandlers` is also once-per-process, so each case needs a
 * fresh one.
 */
async function runChild(source: string): Promise<{ stdout: string; code: number | null }> {
  /*
   * Written to a `.mts` file rather than passed with `--eval`, because `--eval`
   * compiles as CommonJS and the snippets use top-level await. A file with the
   * module extension gets the ESM treatment the snippets need.
   */
  const dir = await mkdtemp(join(tmpdir(), "run-fault-"));
  const file = join(dir, "probe.mts");
  await writeFile(file, source);
  try {
    return await new Promise((resolve) => {
      const child = spawn(TSX, [file], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stdout += String(chunk); });
      child.on("close", (code) => resolve({ stdout, code }));
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const URL_OF = new URL("../../../src/runtime/cleanup-registry.ts", import.meta.url).href;

test("a rejection inside a run with an onFault handler does not end the process", async () => {
  /*
   * The measured failure, in miniature. A promise created inside the run
   * rejects with nothing holding it; the handler must call the run's fault hook
   * and then keep running rather than exiting.
   */
  const { stdout, code } = await runChild(`
    import { installCrashHandlers, runWithCleanupScope } from ${JSON.stringify(URL_OF)};
    installCrashHandlers();
    let faulted = "";
    await runWithCleanupScope(undefined, async () => {
      void (async () => { throw new Error("escaped from a tool call"); })();
      await new Promise((r) => setTimeout(r, 60));
    }, { onFault: (error) => { faulted = error.message; } });
    console.log("STILL ALIVE:", faulted);
    await new Promise((r) => setTimeout(r, 60));
    console.log("PROCESS NOT EXITED");
  `);

  assert.match(stdout, /STILL ALIVE: escaped from a tool call/, `the run's fault hook must see it, got:\n${stdout}`);
  assert.match(stdout, /PROCESS NOT EXITED/, `the process must survive, got:\n${stdout}`);
  assert.equal(code, 0, `expected a clean exit, got ${code}:\n${stdout}`);
});

test("a rejection with no run scope still ends the process", async () => {
  /*
   * The other half, and the reason this is not simply "stop exiting". With no
   * run to blame, an escaped error is a genuine process fault and the fail-fast
   * behaviour is kept. A build or a CLI run depends on it.
   */
  const { stdout, code } = await runChild(`
    import { installCrashHandlers } from ${JSON.stringify(URL_OF)};
    installCrashHandlers();
    void (async () => { throw new Error("no run owns this"); })();
    await new Promise((r) => setTimeout(r, 200));
    console.log("SHOULD NOT REACH HERE");
  `);

  assert.doesNotMatch(stdout, /SHOULD NOT REACH HERE/, `the process must exit, got:\n${stdout}`);
  assert.notEqual(code, 0, "a process-level fault still exits non-zero");
  assert.match(stdout, /no run owns this/, "and the cause is still reported");
});

test("a fault is attributed to its own run, not to a sibling's", async () => {
  /*
   * The attribution has to be per-run, because the whole point is that one
   * thread's error does not cancel another thread. Two runs are live at once
   * here and only the one that raised must be cancelled.
   */
  const { stdout } = await runChild(`
    import { installCrashHandlers, runWithCleanupScope } from ${JSON.stringify(URL_OF)};
    installCrashHandlers();
    const faults = [];
    const quiet = runWithCleanupScope(undefined, async () => {
      await new Promise((r) => setTimeout(r, 300));
      console.log("QUIET RUN FINISHED");
    }, { onFault: () => faults.push("quiet") });

    const noisy = runWithCleanupScope(undefined, async () => {
      void (async () => { throw new Error("only the noisy run"); })();
      await new Promise((r) => setTimeout(r, 120));
    }, { onFault: () => faults.push("noisy") });

    await Promise.allSettled([quiet, noisy]);
    console.log("FAULTED RUNS:", faults.join(","));
  `);

  assert.match(stdout, /FAULTED RUNS: noisy/, `only the raising run is faulted, got:\n${stdout}`);
  assert.match(stdout, /QUIET RUN FINISHED/, "the sibling run completes normally");
});
