import test from "node:test";
import assert from "node:assert/strict";
import { runShellCommandTool } from "../../src/tools/global/run-shell-command.js";

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

test("shell size watchdog kills excessive output command", async () => {
  // Set a very small size limit so the test completes quickly
  process.env.REAPER_MAX_SHELL_OUTPUT_BYTES = "2048";
  let caught: Error | undefined;
  try {
    await runShellCommandTool(
      "/workspace",
      { cmd: "yes", timeoutMs: 10_000 },
      "allow_all",
    );
    assert.fail("Expected command to be killed by size watchdog");
  } catch (err) {
    caught = err as Error;
  } finally {
    delete process.env.REAPER_MAX_SHELL_OUTPUT_BYTES;
  }
  assert.ok(caught);
  assert.match(caught.message, /size limit|excessive output/i);
});
