/**
 * A deleted thread's control lease is dropped with it.
 *
 * `BrowserControlRegistry.forget` existed and was called by nothing, so a lease
 * lived for the life of the server process. The registry is keyed by thread id
 * and the browser tool refuses every action while the owner is `human`, so the
 * case that matters is a thread the user took control of and then deleted: its
 * lease stayed in the map, and a thread later given that id, or a `take`/`return`
 * pair from a pane still polling it, read a record belonging to a browser that
 * no longer exists. The cheaper half of the same bug is that the map only ever
 * grew, one entry per thread the server had ever seen.
 *
 * The wiring is checked through the real delete path rather than by calling
 * `forget` from the test, because "added and never reached" is exactly the shape
 * this fix is about: `deleteThread` is what the app-server calls, and it is what
 * has to carry the call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ThreadBrowsers } from "../../../src/app-server/thread-browsers.js";
import { ReaperThreadManager } from "../../../src/app-server/thread-manager.js";

/** A browser owner that never attaches: every case here is answered without one. */
function browsers(): ThreadBrowsers {
  return new ThreadBrowsers({ cdpUrl: "ws://127.0.0.1:1/devtools" });
}

test("closing a thread's browser drops its lease even when no runtime exists", async () => {
  /*
   * The no-runtime case is the one a restarted server produces, and it is the one
   * that would be missed by putting the call inside the `runtime !== undefined`
   * branch: the browser is broken down from the recorded page ids, and the lease
   * has to go with it.
   */
  const owner = browsers();
  const taken = owner.control.takeControl("gone-thread");
  assert.equal(owner.control.lease("gone-thread").owner, "human", "the precondition: the human holds it");

  await owner.closeThread("gone-thread");

  const after = owner.control.lease("gone-thread");
  assert.equal(after.owner, "agent", "a deleted thread must not still be owned by the human");
  assert.equal(after.generation, 0, "and the record must be the fresh one, not a returned lease");
  assert.ok(taken.generation > 0, "the taken lease was a real handoff, so the reset is not vacuous");
});

test("deleting a thread through the manager drops its lease", async () => {
  /*
   * The real path, end to end: the pane takes control, the user deletes the
   * thread, and the registry no longer has an entry for it. `deleteThread` is
   * asserted rather than `closeThread` because the manager's delete is what the
   * app-server calls, and this is the call that has to exist for the fix to be
   * reachable.
   */
  const dataRoot = await mkdtemp(join(homedir(), ".reaper", "test-lease-forget-"));
  const owner = browsers();
  const manager = new ReaperThreadManager({ dataRoot, threadBrowsers: owner });
  const thread = await manager.startThread({ title: "leased", workspaceRoot: join(dataRoot, "ws") });

  owner.control.takeControl(thread.threadId);
  assert.equal(owner.control.lease(thread.threadId).owner, "human", "the pane took control before the delete");

  await manager.deleteThread(thread.threadId);

  const after = owner.control.lease(thread.threadId);
  assert.equal(after.owner, "agent", "a lease must not outlive the thread it belongs to");
  assert.equal(after.generation, 0, "and it must be gone rather than returned to the agent");
});
