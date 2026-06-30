/**
 * AC7: Extension install succeeds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRegistry } from "../../../src/extensions/registry.js";

test("AC7: extension install succeeds with valid manifest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-install-"));
  const extSrc = join(tmp, "ext-src");
  mkdirSync(join(extSrc, "dist"), { recursive: true });
  writeFileSync(join(extSrc, "extension.json"), JSON.stringify({
    id: "hello",
    version: "1.0.0",
    description: "Test extension",
    main: "dist/index.js",
    engines: { reaper: "^1.0.0" },
    permissions: ["tools:read_file"],
  }));
  writeFileSync(join(extSrc, "package.json"), JSON.stringify({
    name: "hello",
    version: "1.0.0",
    main: "dist/index.js",
  }));
  writeFileSync(join(extSrc, "dist", "index.js"), "export default { activate() {} };");

  const workspaceRoot = join(tmp, "ws");
  const userHome = join(tmp, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const reg = new ExtensionRegistry({
    workspaceRoot,
    userHome,
    builtinRoot: join(tmp, "builtin"),
  });
  const result = reg.install({ srcPath: extSrc, scope: "user" });
  assert.ok(result.ok, `install failed: ${result.error}`);
  // Files were copied into the user install dir.
  const userInstall = join(userHome, ".reaper", "extensions", "hello");
  assert.ok(existsSync(join(userInstall, "extension.json")));
  rmSync(tmp, { recursive: true, force: true });
});

test("AC7b: extension install fails on missing manifest", () => {
  const tmp = mkdtempSync(join(tmpdir(), "reaper-ext-install-"));
  const extSrc = join(tmp, "ext-src");
  mkdirSync(extSrc, { recursive: true });
  const workspaceRoot = join(tmp, "ws");
  const userHome = join(tmp, "home");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(userHome, { recursive: true });
  const reg = new ExtensionRegistry({ workspaceRoot, userHome, builtinRoot: join(tmp, "builtin") });
  const result = reg.install({ srcPath: extSrc, scope: "user" });
  assert.equal(result.ok, false);
  rmSync(tmp, { recursive: true, force: true });
});
