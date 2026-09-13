/**
 * The environment fingerprint tells the model which runtimes and tools exist
 * before it plans any work, so an empty `availableTools` is not a cosmetic
 * problem — it reads as "this machine has nothing installed".
 *
 * It was empty for a long time, on every machine, because the check spawned
 * `execFile('command', ['-v', tool])`. `command` is a POSIX shell builtin
 * with no executable behind it, so all 27 spawns failed with ENOENT and the
 * `catch` swallowed each one. Two things hid it: the field had no consumer
 * that would look wrong, and 27 concurrent spawns made the function slow
 * enough (~500ms, on the first-token path) to look like it was doing work.
 *
 * These tests pin the two properties that were silently false: the list has
 * to reflect what is actually on PATH, and the cost has to stay in the range
 * of one shell invocation rather than two dozen process spawns.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  _resetFingerprintCacheForTests,
  getEnvironmentFingerprint,
  getEnvironmentFingerprintSync,
} from "../../../src/runtime/fingerprint.js";

/**
 * The same list the fingerprint probes. Duplicated deliberately: if the
 * production list changes, these tests should have to be updated on purpose
 * rather than silently following it.
 */
const TOOLS_TO_CHECK = [
  "git", "docker", "docker-compose", "python3", "pip3", "make", "gcc", "g++", "sqlite3", "curl", "wget",
  "pg_isready", "psql", "mysql", "mongosh", "redis-cli", "prisma", "tsx", "ts-node", "next", "vite", "vi",
  "nano", "grep", "find", "sed", "awk", "jq",
];

function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-fingerprint-"));
  _resetFingerprintCacheForTests();
  return fn(root).finally(() => {
    _resetFingerprintCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });
}

/** Ground truth, computed independently of the code under test. */
function resolvesOnPath(tool: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("the fingerprint does not report a tool that is not installed", async () => {
  // The false-positive direction: a tool listed here is one the model will
  // assume it can invoke, so listing an absent one costs a failed command.
  await withWorkspace(async (root) => {
    const fp = await getEnvironmentFingerprint(root);
    for (const tool of fp.availableTools) {
      assert.ok(resolvesOnPath(tool), `${tool} was reported available but does not resolve`);
    }
  });
});

test("the fingerprint reports every installed tool it set out to check", async () => {
  // The false-negative direction, and the one that was actually broken: this
  // is the assertion that fails against `execFile('command', ...)`.
  await withWorkspace(async (root) => {
    const fp = await getEnvironmentFingerprint(root);
    const installed = TOOLS_TO_CHECK.filter(resolvesOnPath);
    for (const tool of installed) {
      assert.ok(
        fp.availableTools.includes(tool),
        `${tool} resolves on PATH but the fingerprint omitted it`,
      );
    }
  });
});

test("a machine with a shell reports at least one available tool", async () => {
  /*
   * The regression test proper. The old implementation returned `[]` here
   * regardless of what was installed, because every probe threw ENOENT. Any
   * environment that can run this suite has at least grep, sed, and sh.
   */
  await withWorkspace(async (root) => {
    const fp = await getEnvironmentFingerprint(root);
    assert.notEqual(
      fp.availableTools.length,
      0,
      "the fingerprint reported no tools at all — the probe is broken, not the machine",
    );
    for (const expected of ["grep", "sed"]) {
      if (resolvesOnPath(expected)) {
        assert.ok(
          fp.availableTools.includes(expected),
          `${expected} resolves on PATH but was not reported`,
        );
      }
    }
  });
});

test("the synchronous variant reports the same tools as the async one", async () => {
  await withWorkspace(async (root) => {
    const asyncFp = await getEnvironmentFingerprint(root);
    _resetFingerprintCacheForTests();
    const syncFp = getEnvironmentFingerprintSync(root);
    assert.deepEqual(syncFp.availableTools, asyncFp.availableTools);
  });
});

test("the async fingerprint is cached per workspace", async () => {
  await withWorkspace(async (root) => {
    const first = await getEnvironmentFingerprint(root);
    const started = Date.now();
    const second = await getEnvironmentFingerprint(root);
    const elapsed = Date.now() - started;
    assert.equal(second, first, "a warm lookup must return the cached object");
    // A warm hit does no I/O. 50ms is loose enough for a loaded machine and
    // still far below the ~300ms a real probe costs.
    assert.ok(elapsed < 50, `cached lookup took ${elapsed}ms and should be instant`);
  });
});

test("a tool probe stays in the range of one shell invocation", async () => {
  /*
   * Guards the cost, not just the answer. The old 27-spawn version took
   * ~500ms on the first-token path; one `sh -c` takes ~300ms, and most of
   * that is the fingerprint's other work (npm -v, ldd, the index). The bound
   * is deliberately generous — this catches a return to per-tool spawning,
   * not a few milliseconds of drift.
   */
  await withWorkspace(async (root) => {
    const started = Date.now();
    await getEnvironmentFingerprint(root);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1200, `cold fingerprint took ${elapsed}ms — is it spawning per tool again?`);
  });
});
