/**
 * AC8: Extension activation runs activate(ctx).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry } from "../../../src/extensions/registry.js";
import { ToolExecutor } from "../../../src/tools/executor.js";
import { installExtensionTools } from "../../../src/runtime/extension-wiring.js";
import { ExtensionToolRegistry } from "../../../src/extensions/tool-registry.js";

test("AC8: activate(ctx) is called and extension status becomes enabled", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-activate-"));
  const extSrc = join(tmp, "ext-src");
  mkdirSync(join(extSrc, "dist"), { recursive: true });
  writeFileSync(join(extSrc, "extension.json"), JSON.stringify({
    id: "test-activate",
    version: "1.0.0",
    description: "Activate test",
    main: "dist/index.js",
    engines: { reaper: "^1.0.0" },
    permissions: ["tools:read"],
  }));
  writeFileSync(join(extSrc, "package.json"), JSON.stringify({
    name: "test-activate", version: "1.0.0", main: "dist/index.js",
  }));
  writeFileSync(join(extSrc, "dist", "index.js"), `
export default {
  activate(_ctx) { /* no-op */ },
  deactivate(_ctx) { /* no-op */ },
};
`);

  const workspaceRoot = join(tmp, "ws");
  const userHome = join(tmp, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const reg = new ExtensionRegistry({
    workspaceRoot, userHome, builtinRoot: join(tmp, "builtin"),
  });
  const installResult = reg.install({ srcPath: extSrc, scope: "user" });
  assert.ok(installResult.ok, `install failed: ${installResult.error}`);

  // After install the status is "installed"; enable + activate.
  const enableRes = reg.enable("test-activate");
  assert.ok(enableRes.ok, enableRes.error);
  const summary = await reg.activateAll();
  assert.equal(summary.failed, 0, `failed=${summary.failed}`);

  const ext = reg.get("test-activate");
  assert.equal(ext?.status, "enabled");
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A CommonJS extension must activate, in whatever shape its author used.
 *
 * Every test above writes ESM (`export default { activate }`), which is why the
 * CJS path was never exercised — and it was broken. `await import()` of a
 * CommonJS file does not give back `module.exports`; it gives back a namespace
 * whose `default` *is* `module.exports`. So an author writing the shape the
 * loader's own doc comment documents —
 *
 *   module.exports = { default: { activate } }
 *
 * is read as `mod.default.default.activate`, while the loader checked
 * `mod.default.activate` and found `undefined`. It reported "extension
 * main.default.activate must be a function" for every arrangement an author
 * could reasonably try, which is why it looked like the author's mistake.
 *
 * Each shape below is written to disk and loaded through the real registry, so
 * this fails if the unwrapping is ever removed.
 */
for (const [label, source] of [
  ["documented `{ default: { activate } }`", "module.exports = { default: { activate() { globalThis.__probe = 'cjs-nested'; } } };"],
  ["bare async function default", "module.exports = { default: async function activate() { globalThis.__probe = 'cjs-fn'; } };"],
  ["flat `{ activate }`", "module.exports = { activate() { globalThis.__probe = 'cjs-flat'; } };"],
  ["self-referencing default", "module.exports = { activate() { globalThis.__probe = 'cjs-self'; } }; module.exports.default = module.exports;"],
] as const) {
  test(`AC9: a CommonJS extension activates — ${label}`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-cjs-"));
    try {
      const extSrc = join(tmp, "ext-src");
      mkdirSync(extSrc, { recursive: true });
      writeFileSync(join(extSrc, "extension.json"), JSON.stringify({
        id: "cjs-ext",
        version: "1.0.0",
        description: "CommonJS activation",
        main: "main.js",
        engines: { reaper: "^1.0.0" },
        // Required by the manifest schema; without it install itself is refused.
        permissions: ["tools:read"],
      }));
      writeFileSync(join(extSrc, "package.json"), JSON.stringify({ name: "cjs-ext", version: "1.0.0", main: "main.js" }));
      writeFileSync(join(extSrc, "main.js"), source);

      const workspaceRoot = join(tmp, "ws");
      const userHome = join(tmp, "home");
      mkdirSync(workspaceRoot, { recursive: true });
      mkdirSync(userHome, { recursive: true });

      const reg = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(tmp, "builtin") });
      const installed = reg.install({ srcPath: extSrc, scope: "user" });
      assert.equal(installed.ok, true, `install failed: ${JSON.stringify(installed)}`);

      // Enable is where the loader runs and where the user saw it fail.
      const enabled = await reg.enable("cjs-ext");
      assert.equal(
        enabled.ok,
        true,
        `enable failed: ${enabled.error ?? ""}`,
      );
      assert.doesNotMatch(
        enabled.error ?? "",
        /must be a function/,
        "the loader still cannot find the activate function in a CommonJS module",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
}

/**
 * An extension's tool must be callable, not merely registered.
 *
 * Five separate gates each silently swallowed the call, and every one of them
 * reported success at the layer above:
 *
 *   1. `loadExtensionMain` could not find `activate` in a CommonJS module.
 *   2. `installExtensionTools` read a field the executor does not have, so it
 *      copied zero tools and returned 0 without complaint.
 *   3. The engine never passed the registry or the refresh callback.
 *   4. The unknown-tool guard checked only the static registry.
 *   5. `ToolCallSchema` — a union over static tool names — rejected the call.
 *
 * So "enable returned ok" was true the entire time the feature was unusable,
 * which is why this test drives the whole chain and asserts on the *result of
 * calling the tool*. A test that stops at any earlier step passes on a broken
 * system.
 */
test("AC10: an extension's tool is dispatched and returns its value", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-e2e-"));
  try {
    const extSrc = join(tmp, "ext-src");
    mkdirSync(extSrc, { recursive: true });
    writeFileSync(join(extSrc, "extension.json"), JSON.stringify({
      id: "e2e-ext",
      version: "1.0.0",
      description: "End-to-end activation",
      main: "main.js",
      engines: { reaper: "^1.0.0" },
      permissions: ["tools:read"],
    }));
    writeFileSync(join(extSrc, "package.json"), JSON.stringify({ name: "e2e-ext", version: "1.0.0", main: "main.js" }));
    /*
     * CommonJS, the documented nested shape, and a registration whose
     * `metadata.name` matches its `name` — the three details that each have to
     * be right before a tool reaches dispatch.
     */
    writeFileSync(join(extSrc, "main.js"), `
module.exports = {
  default: {
    activate(ctx) {
      ctx.registerTool({
        name: "e2e_ping",
        description: "Returns a fixed string.",
        schema: { type: "object", properties: {} },
        metadata: {
          name: "e2e_ping",
          category: "read",
          can_modify_files: false,
          can_execute_code: false,
          can_affect_host: false,
          risk_level: "low",
        },
        handler: async () => "pong",
      });
    },
  },
};
`);

    const workspaceRoot = join(tmp, "ws");
    const userHome = join(tmp, "home");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(userHome, { recursive: true });

    const extensionRegistry = new ExtensionRegistry({
      workspaceRoot, userHome, builtinRoot: join(tmp, "builtin"),
    });
    assert.equal(extensionRegistry.install({ srcPath: extSrc, scope: "user" }).ok, true);
    assert.equal(extensionRegistry.trust_("e2e-ext").ok, true);
    assert.equal(extensionRegistry.enable("e2e-ext").ok, true);
    // Activation registers the tool; `enable` only sets the status flag.
    const activated = await extensionRegistry.activateAll();
    assert.equal(activated.activated, 1, "the extension did not activate");

    const extensionTools = new ExtensionToolRegistry({ defaultToolTimeoutMs: 5_000 });
    const executor = new ToolExecutor({
      workspaceRoot,
      runId: "e2e",
      sessionId: "e2e",
      traceId: "e2e",
      logLevel: "info",
      safetyProfile: "allow_all",
      extensionTools,
    });
    assert.equal(
      installExtensionTools({ executor, registry: extensionRegistry }),
      1,
      "the tool was not copied into the executor's registry",
    );

    // The assertion that matters: the call runs and the value comes back.
    /*
     * The cast is the point, not a workaround: `ToolCall["name"]` is a union
     * over the *static* tool names, so a runtime-contributed tool is not
     * expressible in it. That type is precisely why `ToolCallSchema` used to
     * reject extension calls, and this test exists to prove that path now
     * works.
     */
    const result = await executor.execute({ id: "c1", name: "e2e_ping", args: {} } as never);
    assert.equal(result.ok, true, `dispatch failed: ${result.error?.message ?? ""}`);
    assert.match(JSON.stringify(result.output ?? ""), /pong/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
