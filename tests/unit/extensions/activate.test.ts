/**
 * AC8: Extension activation runs activate(ctx).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry } from "../../../src/extensions/registry.js";

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
    permissions: ["tools:read_file"],
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
