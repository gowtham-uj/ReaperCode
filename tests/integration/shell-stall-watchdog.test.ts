import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runShellCommandTool, isForegroundShellResult } from "../../src/tools/global/run-shell-command.js";

test("shell stall watchdog kills interactive prompt command", async () => {
  // Shorten the stall watchdog timers for testing
  process.env.REAPER_STALL_WATCHDOG_INTERVAL_MS = "500";
  process.env.REAPER_STALL_WATCHDOG_NO_OUTPUT_MS = "1500";
  let caught: Error | undefined;
  try {
    await runShellCommandTool(
      "/workspace",
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
    await runShellCommandTool(
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
  const result = await runShellCommandTool(
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
  assert.ok(Date.now() - started < 4_500, "foreground command should not wait for orphan child until timeout");

  let stillRunning = false;
  try {
    execFileSync("pgrep", ["-f", marker], { stdio: "ignore" });
    stillRunning = true;
  } catch {
    stillRunning = false;
  }
  assert.equal(stillRunning, false, "foreground cleanup should terminate leftover child process");
});

test("shell output spill keeps command running and writes foreground output to a process log", async () => {
  process.env.REAPER_MAX_SHELL_OUTPUT_BYTES = "2048";
  const workspace = await mkdtemp(path.join(tmpdir(), "reaper-shell-spill-workspace-"));
  const artifactDir = await mkdtemp(path.join(tmpdir(), "reaper-shell-spill-artifacts-"));
  try {
    const result = await runShellCommandTool(
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
