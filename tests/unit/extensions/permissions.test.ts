/**
 * AC11: Extension permission check (deny on missing).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionPermissionManager } from "../../../src/extensions/permission-manager.js";

test("AC11: check() returns true only for granted permissions", () => {
  const pm = new ExtensionPermissionManager();
  pm.grant("ext1", ["tools:read_file"]);
  assert.equal(pm.check("ext1", "tools:read_file"), true);
  assert.equal(pm.check("ext1", "tools:write_file"), false);
  assert.equal(pm.check("ext2", "tools:read_file"), false);
});

test("AC11b: revoke() removes the permission", () => {
  const pm = new ExtensionPermissionManager();
  pm.grant("ext1", ["tools:write_file", "tools:read_file"]);
  pm.revoke("ext1", "tools:write_file");
  assert.equal(pm.check("ext1", "tools:write_file"), false);
  assert.equal(pm.check("ext1", "tools:read_file"), true);
});

test("AC11c: list() returns the granted set", () => {
  const pm = new ExtensionPermissionManager();
  pm.grant("ext-a", ["tools:network", "tools:read_file"]);
  const list = pm.list("ext-a");
  assert.ok(list.includes("tools:network"));
  assert.ok(list.includes("tools:read_file"));
});
