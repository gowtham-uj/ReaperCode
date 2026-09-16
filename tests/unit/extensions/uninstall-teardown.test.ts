/**
 * Uninstalling an extension stops everything it started.
 *
 * The first version deleted the folder and cleared the tool registry, which is
 * about half of what an extension is. It also registers hook handlers on the
 * shared runner, holds permissions granted from its manifest, and may start a
 * timer in `activate()`. None of those were touched, so an uninstalled
 * extension kept observing every tool call, with its directory gone and its
 * name absent from `list()`: the state looked clean and the code kept running.
 *
 * `deactivate` was unreachable as well, because `deactivateAll` re-imports from
 * `installPath` and the path had already been deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionRegistry } from "../../../src/extensions/registry.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";

function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), "ext-teardown-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  const installPath = join(userHome, ".reaper", "extensions", id);
  mkdirSync(installPath, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(installPath, "extension.json"), JSON.stringify({
    id, version: "1.0.0", description: "teardown probe", main: "main.js",
    engines: { reaper: "^1.0.0" }, permissions: [],
  }));
  writeFileSync(join(installPath, "main.js"), `
export default {
  activate(ctx) {
    ctx.registerHook({ event: "PreToolUse", handler: async () => ({ allow: true }) });
    globalThis["__reaper_teardown_timer"] = setInterval(() => {}, 1000);
  },
  deactivate() { clearInterval(globalThis["__reaper_teardown_timer"]); globalThis["__reaper_deactivated"] = true; },
};
`);
  const runner = new HookRunner();
  const registry = new ExtensionRegistry({
    workspaceRoot, userHome, builtinRoot: join(root, "builtin"), hookRunner: runner,
  });
  return { registry, runner, installPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("an uninstalled extension stops firing its hooks and is deactivated", async () => {
  delete (globalThis as { __reaper_deactivated?: boolean }).__reaper_deactivated;
  const fx = fixture("teardown-ext");
  try {
    fx.registry.discover();
    await fx.registry.activateAll();
    assert.equal(fx.registry.get("teardown-ext")?.status, "enabled");

    // It is live now, which is what makes the assertions below meaningful.
    const live = await fx.runner.dispatch("PreToolUse" as never, { toolName: "bash", args: {} });
    assert.equal(live.results.length, 1, "the extension's hook must be registered while it is installed");

    const result = await fx.registry.uninstall("teardown-ext");
    assert.equal(result.ok, true);
    assert.equal(existsSync(fx.installPath), false, "the folder must be gone");

    /*
     * The part that was missing. A handler left on the runner sees every
     * `PreToolUse` payload, which includes tool arguments.
     */
    const after = await fx.runner.dispatch("PreToolUse" as never, { toolName: "bash", args: {} });
    assert.equal(after.results.length, 0, "the hook must not fire after uninstall");
    assert.equal(
      (globalThis as { __reaper_deactivated?: boolean }).__reaper_deactivated,
      true,
      "deactivate must have run, or the extension's timers and subscriptions leak",
    );
  } finally {
    fx.cleanup();
    delete (globalThis as { __reaper_deactivated?: boolean }).__reaper_deactivated;
  }
});
