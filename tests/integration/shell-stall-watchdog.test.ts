import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeBashTool, isForegroundShellResult, resolveShellBinary } from "../../src/tools/global/bash.js";

test("shell binary resolution returns a trusted absolute path", () => {
  const shell = resolveShellBinary();
  assert.equal(path.isAbsolute(shell), true);
  if (process.platform === "win32") {
    assert.match(shell.replace(/\\/g, "/"), /\/Git\/(?:bin|usr\/bin)\/bash\.exe$/i);
  }
});

test("shell stall watchdog kills interactive prompt command", async () => {
  // Shorten the stall watchdog timers for testing
  process.env.REAPER_STALL_WATCHDOG_INTERVAL_MS = "500";
  process.env.REAPER_STALL_WATCHDOG_NO_OUTPUT_MS = "1500";
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-stall-"));
  let caught: Error | undefined;
  try {
    await executeBashTool(
      workspace,
      { cmd: 'bash -c \'echo "(y/n)"; sleep 60\'', timeoutMs: 120_000 },
      "allow_all",
    );
    assert.fail("Expected command to be killed by stall watchdog");
  } catch (err) {
    caught = err as Error;
  } finally {
    delete process.env.REAPER_STALL_WATCHDOG_INTERVAL_MS;
    delete process.env.REAPER_STALL_WATCHDOG_NO_OUTPUT_MS;
  }
  assert.ok(caught);
  assert.match(caught.message, /stalled|interactive prompt/i);
});

test("package-manager version probes do not require package.json", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-version-probe-"));
  try {
    await executeBashTool(
      workspace,
      { cmd: "pnpm --version", timeoutMs: 10_000 },
      "allow_all",
      workspace,
    );
  } catch (err) {
    const message = (err as Error).message;
    assert.doesNotMatch(message, /has no package\.json|found no package with script/);
  }
});

test("foreground shell returns after wrapper exit even if a temporary child keeps stdio open", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-foreground-child-"));
  const marker = `reaper-fg-orphan-${Date.now()}-${process.pid}`;
  const started = Date.now();
  const result = await executeBashTool(
    workspace,
    {
      cmd: `node -e "process.title=${JSON.stringify(marker)}; setInterval(()=>{},1000)" & printf 'foreground-done\\n'`,
      timeoutMs: 5_000,
    },
    "allow_all",
    workspace,
  );
  assert.ok(isForegroundShellResult(result), "test command should produce a foreground shell result");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /foreground-done/);
  // Pi-style idle grace is 250ms; allow generous slack for slow CI.
  assert.ok(Date.now() - started < 4_500, "foreground command should not wait for orphan child until timeout");
  // Cleanup: best-effort kill of the leftover so the test process exits cleanly.
  try {
    execFileSync("pkill", ["-f", marker], { stdio: "ignore" });
  } catch {
    // ignore: marker may have already exited.
  }
});

test("foreground shell resolves quickly when inner bash -c leaves a grandchild server running", async () => {
  // Reproduces the live A/B hang: an inner `bash -c` starts a server with `&`,
  // prints its exit marker, and exits — leaving a grandchild holding the
  // wrapper's stdout/stderr pipes. Pi's waitForChildProcess pattern (see
  // earendil-works/pi#5303) is what allows us to finalize the bash tool
  // result without killing the orphan; we mirror that pattern in
  // executeBashTool's close handler.
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-grandchild-"));
  const marker = `reaper-grandchild-${Date.now()}-${process.pid}`;
  const innerCmd = `node -e "process.title=${JSON.stringify(marker)}; setInterval(()=>{},1000)" & printf 'orphan-backgrounded\\n'`;
  const started = Date.now();
  const result = await executeBashTool(
    workspace,
    {
      cmd: `bash -c ${JSON.stringify(innerCmd)}`,
      timeoutMs: 5_000,
    },
    "allow_all",
    workspace,
  );
  assert.ok(isForegroundShellResult(result), "expected foreground shell result");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /orphan-backgrounded/);
  assert.ok(Date.now() - started < 4_500, "foreground bash with backgrounded grandchild must not hang to the wall-clock timeout");
  // Best-effort cleanup so the test process exits cleanly.
  try {
    execFileSync("pkill", ["-f", marker], { stdio: "ignore" });
  } catch {
    // ignore
  }
});

test("shell output spill keeps command running and writes foreground output to a process log", async () => {
  process.env.REAPER_MAX_SHELL_OUTPUT_BYTES = "2048";
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-spill-workspace-"));
  const artifactDir = await mkdtemp(path.join(tmpdir(), "reaper-shell-spill-artifacts-"));
  try {
    const result = await executeBashTool(
      workspace,
      { cmd: "node -e \"for (let i = 0; i < 500; i++) console.log('line-' + i + '-' + 'x'.repeat(40))\"", timeoutMs: 10_000 },
      "allow_all",
      workspace,
      undefined,
      { runId: "run-spill", artifactDir, toolCallId: "tool-spill" },
    );

    if (!("exitCode" in result)) throw new Error("expected foreground shell result");
    assert.equal(result.exitCode, 0);
    assert.ok(result.logPath, "foreground shell result should expose a process log path");
    assert.ok((result.persistedOutputSize ?? 0) > 2048, "should report full output size beyond threshold");
    assert.match(result.stdout, /REAPER OUTPUT SPILLED/);
    assert.match(result.stdout, /line-499/);
    const log = await readFile(result.logPath!, "utf8");
    assert.match(log, /line-0/);
    assert.match(log, /line-499/);
  } finally {
    delete process.env.REAPER_MAX_SHELL_OUTPUT_BYTES;
  }
});
