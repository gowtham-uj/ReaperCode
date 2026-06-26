import test from "node:test";
import assert from "node:assert/strict";

import {
  ExtensionLifecycleEventBus,
  type ExtensionLifecycleEvent,
} from "../../src/extensions/lifecycle-events.js";
import type { LoadedExtension } from "../../src/extensions/types.js";

function extension(id: string, trust: LoadedExtension["trust"] = "user-trusted", status: LoadedExtension["status"] = "enabled"): LoadedExtension {
  return {
    id,
    trust,
    status,
    installPath: `/tmp/${id}`,
    loadedAt: 1,
    manifest: {
      id,
      version: "1.0.0",
      description: id,
      main: "index.js",
      engines: { reaper: "^1.0.0" },
      permissions: [],
    },
  };
}

test("ExtensionLifecycleEventBus dispatches session/model/tool/compaction/project-trust events to trusted extensions", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const seen: ExtensionLifecycleEvent[] = [];
  bus.register(extension("trusted"), async (event) => { seen.push(event); });

  await bus.emit({ type: "session_start", reason: "new" });
  await bus.emit({ type: "before_model_request", role: "main_reasoner", source: "main_agent" });
  await bus.emit({ type: "after_tool_call", toolName: "read_file", result: { ok: true } });
  await bus.emit({ type: "after_compaction", summary: "summary" });
  await bus.emit({ type: "project_trust", workspaceRoot: "/repo" });

  assert.deepEqual(seen.map((event) => event.type), [
    "session_start",
    "before_model_request",
    "after_tool_call",
    "after_compaction",
    "project_trust",
  ]);
});

test("ExtensionLifecycleEventBus skips disabled and project-untrusted extensions", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const seen: string[] = [];
  bus.register(extension("disabled", "user-trusted", "disabled"), async () => { seen.push("disabled"); });
  bus.register(extension("untrusted", "project-untrusted", "enabled"), async () => { seen.push("untrusted"); });
  bus.register(extension("builtin", "builtin", "enabled"), async () => { seen.push("builtin"); });

  await bus.emit({ type: "session_shutdown", reason: "done" });
  assert.deepEqual(seen, ["builtin"]);
});

test("ExtensionLifecycleEventBus isolates handler failures and reports diagnostics", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const seen: string[] = [];
  bus.register(extension("bad"), async () => { throw new Error("boom"); });
  bus.register(extension("good"), async () => { seen.push("good"); });

  const outcome = await bus.emit({ type: "before_tool_call", toolName: "write_file", args: { path: "x" } });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diagnostics[0]?.extensionId, "bad");
  assert.match(outcome.diagnostics[0]?.error ?? "", /boom/);
  assert.deepEqual(seen, ["good"]);
});

test("ExtensionLifecycleEventBus unregisters extensions", async () => {
  const bus = new ExtensionLifecycleEventBus();
  const seen: string[] = [];
  bus.register(extension("gone"), async () => { seen.push("gone"); });
  assert.equal(bus.unregister("gone"), 1);
  await bus.emit({ type: "session_start", reason: "resume" });
  assert.deepEqual(seen, []);
});
