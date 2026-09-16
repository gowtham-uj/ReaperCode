/**
 * The smaller correctness findings, each one a tool that reported something
 * that was not true.
 *
 * These are grouped because they share a shape: the code did work, and the
 * answer it gave about that work disagreed with it. That matters more for an
 * agent than for a program, because the model's next step is built on the
 * answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeApplyPatch } from "../../../src/tools/apply-patch.js";
import { HookRunner } from "../../../src/extensions/hook-runner.js";
import { runnerAsHooks } from "../../../src/runtime/hook-bridge.js";
import { ExtensionRegistry } from "../../../src/extensions/registry.js";
import { ExtensionLifecycle } from "../../../src/extensions/lifecycle.js";
import { handleEnableExtension, handleListExtensions } from "../../../src/tools/write/extension-tools.js";

/** A workspace holding one file, for the patch tests. */
function withFile(content: string): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "correctness-"));
  writeFileSync(join(root, "p.txt"), content);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/*
 * `applied` was `allApplied && !dryRun`, and `allApplied` stays true for a patch
 * whose every file took the `unchanged` branch. So a patch that changed nothing
 * reported `applied: true`, which is the aggregate callers read; "wrote the
 * file" and "wrote nothing" were the same answer.
 */
test("apply_patch reports whether anything was actually written", async () => {
  const noop = "--- a/p.txt\n+++ b/p.txt\n@@ -1,2 +1,2 @@\n one\n two\n";
  const real = "--- a/p.txt\n+++ b/p.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n";

  const untouched = withFile("one\ntwo\n");
  try {
    const result = await executeApplyPatch(noop, untouched.root, false);
    assert.equal(result.files[0]!.action, "unchanged");
    assert.equal(result.applied, false, "a patch that changed nothing must not report itself applied");
  } finally {
    untouched.cleanup();
  }

  const changed = withFile("one\ntwo\n");
  try {
    const result = await executeApplyPatch(real, changed.root, false);
    assert.equal(result.files[0]!.action, "modified");
    assert.equal(result.applied, true);
    assert.equal(readFileSync(join(changed.root, "p.txt"), "utf8"), "one\nthree\n");
  } finally {
    changed.cleanup();
  }
});

/*
 * `firstDenyReason` is set only on deny or timeout, so an `enforce: false`
 * hook's message never reached the allow path and was dropped. The executor
 * reads `preHookResult.message` and attaches it as the result's `hint`, so every
 * advice-only hook was inert: it ran, returned a sentence, and nothing showed it.
 */
test("an observe-only hook's advice reaches the tool result", async () => {
  const runner = new HookRunner();
  runner.register("advice", "PreToolUse", async () => ({ allow: true, message: "use file_view, not bash" }), {});
  const hooks = runnerAsHooks(runner)!;
  const emitted = await hooks.emit({ name: "PreToolUse", payload: { toolName: "bash", args: {} } } as never);
  assert.equal(emitted.allow, true);
  assert.equal(emitted.message, "use file_view, not bash");
});

test("a blocking hook still blocks, with its reason", async () => {
  const runner = new HookRunner();
  runner.register("guard", "PreToolUse", async () => ({ allow: false, reason: "BLOCKED" }), {});
  const hooks = runnerAsHooks(runner)!;
  const emitted = await hooks.emit({ name: "PreToolUse", payload: { toolName: "bash", args: {} } } as never);
  assert.equal(emitted.allow, false);
  assert.equal(emitted.message, "BLOCKED");
});

/*
 * `discover()` rebuilt every record from disk, dropping `status` and `error`,
 * which are facts about this process that the disk knows nothing about. The
 * manager calls `discover()` before every action, so `enable` reported
 * `activated: true` and the next `list` said `installed`.
 */
test("enable and list agree about an extension's status", async () => {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  const installPath = join(userHome, ".reaper", "extensions", "probe");
  mkdirSync(installPath, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(installPath, "extension.json"), JSON.stringify({
    id: "probe", version: "1.0.0", description: "d", main: "main.js",
    engines: { reaper: "^1.0.0" }, permissions: [],
  }));
  writeFileSync(join(installPath, "main.js"), "export default { activate() {}, deactivate() {} };\n");
  try {
    const registry = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(root, "builtin") });
    const deps = { lifecycle: new ExtensionLifecycle(registry), registry, workspaceRoot, userHome } as never;

    registry.discover();
    const before = await handleListExtensions(deps);
    assert.equal(before.extensions.find((e) => e.id === "probe")?.status, "installed");

    const enabled = await handleEnableExtension({ action: "enable", id: "probe" } as never, deps);
    assert.equal((enabled as { ok: boolean }).ok, true);

    // The list re-walks the disk first, which is what used to erase the status.
    const after = await handleListExtensions(deps);
    assert.equal(
      after.extensions.find((e) => e.id === "probe")?.status,
      "enabled",
      "the inventory must agree with what enable just did",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * `createDraft` writes every skill to the user root regardless of the
 * manifest's own scope, and `uninstall` built its path from the *caller's*
 * scope. Creating with `scope: "project"` and uninstalling with
 * `scope: "project"` therefore looked in the project directory, found nothing,
 * and returned `ok: true` while the skill sat in the user directory: gone from
 * the registry, invisible to `list`, and still served by `activate_skill`.
 */
test("skill uninstall removes the skill wherever it actually is", async () => {
  const { SkillRegistry } = await import("../../../src/skills/registry.js");
  const { SkillLifecycle } = await import("../../../src/skills/lifecycle.js");
  const { SkillMemoryRegistry } = await import("../../../src/adaptive/skill-memory-registry.js");
  const { TrustResolver } = await import("../../../src/skills/trust.js");
  const { existsSync } = await import("node:fs");

  const root = mkdtempSync(join(tmpdir(), "skill-uninstall-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  const builtinRoot = join(root, "builtin");
  for (const dir of [workspaceRoot, userHome, builtinRoot]) mkdirSync(dir, { recursive: true });
  try {
    const memory = new SkillMemoryRegistry({ workspaceRoot, userHome });
    const registry = new SkillRegistry({ builtinMetadata: {}, memory });
    const resolver = new TrustResolver({
      builtinRoot,
      userHomeSkillsDir: join(userHome, ".reaper", "skills"),
      projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
    });
    const lifecycle = new SkillLifecycle({ registry, memory, resolver, workspaceRoot, userHome, builtinRoot });

    const created = lifecycle.createDraft(
      { name: "ghost", description: "d", scope: "project", version: "1.0.0", tools: [], triggers: [] } as never,
      "BODY",
    );
    assert.equal(created.ok, true);
    const onDisk = join(userHome, ".reaper", "skills", "ghost");
    assert.equal(existsSync(onDisk), true, "createDraft writes to the user root");

    // Uninstalled with the scope the manifest declared, which is not where it is.
    const removed = lifecycle.uninstall("ghost", "project");
    assert.equal(removed.ok, true);
    assert.equal(existsSync(onDisk), false, "the skill must actually be gone, not merely forgotten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
