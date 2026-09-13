/**
 * A run's directory has to be private.
 *
 * `ensureReaperRunContext` creates `.reaper/sessions/<runId>` and, by way of
 * `recursive: true`, every directory above it — including the thread's
 * workspace root under `~/.reaper/workspaces/<threadId>`. It passed no `mode`,
 * so those directories took the process umask and landed at 0755: world-
 * readable, on paths holding a session transcript.
 *
 * The asymmetry is what made it hard to see. `createThreadWorkspace` in the
 * app-server does pass `0o700`, so a thread created through `thread/start`
 * looked correct; a workspace first touched by a turn's run-context setup
 * looked the same in `ls` and was a different mode. One directory in this repo
 * was found at 0755 next to siblings at 0700 for exactly that reason.
 *
 * These tests pin the mode on both branches and on the intermediate
 * directories, because that is the part `mkdir` propagates and the part the
 * workspace root actually is.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReaperRunContext, ensureReaperRunContext } from "../../../src/runtime/run-manager.js";
import { getReaperScratchpadPaths } from "../../../src/workspace/scratchpad.js";
import type { AgentRequestEnvelope } from "../../../src/connection/schemas.js";

const mode = (target: string): string => (statSync(target).mode & 0o777).toString(8);

function envelope(): AgentRequestEnvelope {
  return {
    connection_id: "test",
    session_id: "session-under-test",
    turn_id: "turn-under-test",
    request_id: "request-under-test",
    message_type: "user_prompt",
    timestamp: new Date().toISOString(),
    trace_id: "turn-under-test",
    metadata: { transport: "websocket" },
    payload: { prompt: "hello" },
  } as unknown as AgentRequestEnvelope;
}

function withWorkspace<T>(fn: (root: string) => Promise<T>): Promise<T> {
  // The fixture itself starts life at the umask mode; the assertions below are
  // about what the code creates inside it, not about this directory.
  const root = mkdtempSync(path.join(tmpdir(), "reaper-perms-"));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("the run directory is created private, not umask-readable", async () => {
  await withWorkspace(async (root) => {
    const request = envelope();
    const context = createReaperRunContext(root, request, { namedSession: "spec-session" });
    await ensureReaperRunContext(context, request);
    assert.equal(
      mode(context.runDir),
      "700",
      `run directory has mode ${mode(context.runDir)}; a session transcript lives here`,
    );
  });
});

test("every directory above the run directory is private too", async () => {
  /*
   * This is the assertion that would have caught the original bug in the
   * place it mattered. `mkdir({recursive: true})` applies its mode to each
   * directory it creates, so a workspace root that did not exist yet was
   * created by this call — at the umask mode, one level above the run
   * directory the code was thinking about.
   */
  await withWorkspace(async (root) => {
    const scratchpad = getReaperScratchpadPaths(root);
    const request = envelope();
    const context = createReaperRunContext(root, request, { namedSession: "spec-session" });
    await ensureReaperRunContext(context, request);

    for (const [label, target] of [
      [".reaper", scratchpad.root],
      [".reaper/sessions", scratchpad.sessions],
    ] as const) {
      assert.equal(
        mode(target),
        "700",
        `${label} has mode ${mode(target)}; thread transcripts are reachable from it`,
      );
    }
  });
});

test("a nested workspace root created by the run context is private", async () => {
  /*
   * The exact shape of the reported case: a thread workspace under a home
   * directory, created by the first turn rather than by `thread/start`.
   */
  await withWorkspace(async (root) => {
    const nested = path.join(root, "home", ".reaper", "workspaces", "thread-under-test");
    const request = envelope();
    const context = createReaperRunContext(nested, request, { namedSession: "spec-session" });
    await ensureReaperRunContext(context, request);

    for (const target of [
      path.join(root, "home"),
      path.join(root, "home", ".reaper"),
      path.join(root, "home", ".reaper", "workspaces"),
      nested,
    ]) {
      assert.equal(
        mode(target),
        "700",
        `${target} has mode ${mode(target)}; it was created by the run-context setup`,
      );
    }
  });
});

test("dev mode creates its artifacts directory private as well", async () => {
  const previous = process.env.REAPER_DEV;
  process.env.REAPER_DEV = "1";
  try {
    await withWorkspace(async (root) => {
      const request = envelope();
      const context = createReaperRunContext(root, request, { namedSession: "spec-session" });
      await ensureReaperRunContext(context, request);
      assert.equal(
        mode(context.artifactsDir),
        "700",
        `artifacts directory mode ${mode(context.artifactsDir)}`,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.REAPER_DEV;
    else process.env.REAPER_DEV = previous;
  }
});
