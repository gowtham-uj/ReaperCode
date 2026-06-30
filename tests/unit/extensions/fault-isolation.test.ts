/**
 * AC12: Extension failure isolation.
 * If activate(ctx) throws, the engine still works and the extension
 * is marked as "failed" with the error message stored.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry } from "../../../src/extensions/registry.js";

test("AC12: throwing extension is marked failed; activation continues for others", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-fault-"));
  const workspaceRoot = join(tmp, "ws");
  const userHome = join(tmp, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });

  const sources: Array<[string, string]> = [
    ["boom", `export default { activate() { throw new Error("intentional"); } };`],
    ["ok", `export default { activate() {} };`],
  ];
  for (const [id, code] of sources) {
    const dir = join(tmp, `${id}-src`);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "extension.json"), JSON.stringify({
      id, version: "1.0.0", description: id, main: "dist/index.js",
      engines: { reaper: "^1.0.0" }, permissions: [],
    }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: id, version: "1.0.0", main: "dist/index.js",
    }));
    writeFileSync(join(dir, "dist", "index.js"), code);
  }

  const reg = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(tmp, "builtin") });
  reg.install({ srcPath: join(tmp, "boom-src"), scope: "user", trust: true });
  reg.install({ srcPath: join(tmp, "ok-src"), scope: "user", trust: true });
  reg.enable("boom");
  reg.enable("ok");
  const summary = await reg.activateAll();
  // The throwing extension contributes to `failed`; the OK one is enabled.
  assert.ok(summary.failed >= 1, `expected at least 1 failure, got ${summary.failed}`);
  assert.equal(reg.get("boom")?.status, "failed");
  assert.equal(reg.get("ok")?.status, "enabled");
  rmSync(tmp, { recursive: true, force: true });
});
