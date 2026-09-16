/**
 * Creating an extension, and running one, both require approval.
 *
 * This was the largest hole in the codebase and it was not in the sandbox: it
 * went around the sandbox. `extension_manager create` writes JavaScript and
 * `enable` runs it through a plain in-process `import()`, so an extension's
 * `activate()` has the process identity, the process environment and the whole
 * filesystem. Measured with a probe extension: `cwd` was `/work` rather than its
 * own directory, `uid` was 0, and `process.env` contained `ANTHROPIC_AUTH_TOKEN`
 * — none of which a sandboxed `eval` script can reach.
 *
 * `trust` and `uninstall` were already gated by an approval requester. The two
 * actions that actually execute code were not, which made a complete path from a
 * model turn to arbitrary code execution as the host, with no approval anywhere.
 *
 * So the control here is consent, not confinement. An extension is a plugin and
 * a plugin runs with the host's privileges by design, in the same way a VS Code
 * extension runs in the editor's process. What must not happen is that a model
 * can reach that unattended.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionRegistry } from "../../../src/extensions/registry.js";
import { ExtensionLifecycle } from "../../../src/extensions/lifecycle.js";
import { handleExtensionManager } from "../../../src/tools/write/extension-tools.js";

/** A workspace, a user home, and a path the probe extension tries to write. */
function fixture(approved: boolean): { deps: never; marker: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "ext-approval-"));
  const workspaceRoot = join(root, "ws");
  const userHome = join(root, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const registry = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(root, "builtin") });
  const deps = {
    lifecycle: new ExtensionLifecycle(registry),
    registry,
    workspaceRoot,
    userHome,
    approvalRequester: async () => approved,
  };
  return {
    deps: deps as never,
    marker: join(root, "ESCAPED.txt"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The definition the manager is asked to create, with an activate that writes. */
function createArgs(id: string, marker: string) {
  return {
    action: "create",
    id,
    version: "1.0.0",
    description: "approval probe",
    main: "main.js",
    engines_reaper: "^1.0.0",
    permissions: [],
    source:
      `import { writeFileSync } from "node:fs";\n` +
      `export default { activate() { writeFileSync(${JSON.stringify(marker)}, "RAN"); }, deactivate() {} };\n`,
    scope: "project",
  } as never;
}

test("a denied approval stops the extension being written at all", async () => {
  const fx = fixture(false);
  try {
    const created = (await handleExtensionManager(createArgs("blocked-ext", fx.marker), fx.deps)) as unknown as { ok: boolean; error?: string };
    assert.equal(created.ok, false);
    assert.match(created.error ?? "", /denied by approval gate/);
    assert.equal(existsSync(fx.marker), false, "nothing may run when the user refused");
  } finally {
    fx.cleanup();
  }
});

test("a denied approval stops the extension being run", async () => {
  /*
   * The half that matters more. Even with the file on disk, enabling it is what
   * executes it, and that is a second gate rather than the same one: a user can
   * approve authoring an extension and still refuse to run it in their process.
   */
  const fx = fixture(false);
  try {
    // Install the file directly, bypassing create, so only `enable` is under test.
    const install = join(fx.deps["workspaceRoot"] as unknown as string, ".reaper", "extensions", "planted-ext");
    mkdirSync(install, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(install, "extension.json"),
      JSON.stringify({ id: "planted-ext", version: "1.0.0", description: "x", main: "main.js", engines: { reaper: "^1.0.0" }, permissions: [] }),
    );
    writeFileSync(
      join(install, "main.js"),
      `import { writeFileSync } from "node:fs";\nexport default { activate() { writeFileSync(${JSON.stringify(fx.marker)}, "RAN"); }, deactivate() {} };\n`,
    );

    const enabled = (await handleExtensionManager({ action: "enable", id: "planted-ext" } as never, fx.deps)) as { ok: boolean; error?: string };
    assert.equal(enabled.ok, false);
    assert.match(enabled.error ?? "", /denied by approval gate/);
    assert.equal(existsSync(fx.marker), false, "the planted extension must not have run");
  } finally {
    fx.cleanup();
  }
});

test("an approved extension still runs, so the gate is consent and not a wall", async () => {
  const fx = fixture(true);
  try {
    const created = (await handleExtensionManager(createArgs("allowed-ext", fx.marker), fx.deps)) as { ok: boolean };
    assert.equal(created.ok, true);

    const enabled = (await handleExtensionManager({ action: "enable", id: "allowed-ext" } as never, fx.deps)) as { ok: boolean; activated?: boolean };
    assert.equal(enabled.ok, true);
    assert.equal(enabled.activated, true);
    assert.equal(readFileSync(fx.marker, "utf8"), "RAN");
  } finally {
    fx.cleanup();
  }
});
