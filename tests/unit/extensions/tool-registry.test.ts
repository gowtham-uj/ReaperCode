/**
 * AC9: Extension tool registration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionToolRegistry } from "../../../src/extensions/tool-registry.js";
import type { ToolMetadata } from "../../../src/governance/tool-metadata.js";

const ALL_ROLES = ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"] as const;

const READ_METADATA: ToolMetadata = {
  name: "ext.read",
  category: "read",
  risk_level: "low",
  is_read_only: true,
  can_modify_files: false,
  can_execute_code: false,
  can_control_ui: false,
  can_affect_host: false,
  requires_approval: false,
  preferred_before: [],
  preferred_after: [],
  forbidden_in_roles: [],
  allowed_in_roles: [...ALL_ROLES],
};

const WRITE_METADATA: ToolMetadata = {
  name: "ext.write",
  category: "write",
  risk_level: "medium",
  is_read_only: false,
  can_modify_files: true,
  can_execute_code: false,
  can_control_ui: false,
  can_affect_host: false,
  requires_approval: false,
  preferred_before: [],
  preferred_after: [],
  forbidden_in_roles: [],
  allowed_in_roles: [...ALL_ROLES],
};

test("AC9: register + hasTool + getDefinition work", () => {
  const reg = new ExtensionToolRegistry();
  reg.register({
    extensionId: "ext-x",
    definition: { name: "ext.read", description: "Read a file" },
    metadata: READ_METADATA,
    handler: async () => ({ ok: true }),
  });
  assert.equal(reg.hasTool("ext.read"), true);
  assert.equal(reg.hasTool("not.registered"), false);
  const def = reg.getDefinition("ext.read");
  assert.equal(def?.name, "ext.read");
});

test("AC9b: unregister removes the tool", () => {
  const reg = new ExtensionToolRegistry();
  reg.register({
    extensionId: "ext-y",
    definition: { name: "ext.read", description: "x" },
    metadata: READ_METADATA,
    handler: async () => ({ ok: true }),
  });
  reg.unregister("ext.read");
  assert.equal(reg.hasTool("ext.read"), false);
});

test("AC9c: executeTool denies when no permission", async () => {
  const reg = new ExtensionToolRegistry();
  reg.register({
    extensionId: "ext-z",
    definition: { name: "ext.write", description: "Write a file" },
    metadata: WRITE_METADATA,
    handler: async () => ({ ok: true }),
  });
  const result = await reg.executeTool("ext.write", { path: "/tmp/x" }, {
    extensionId: "ext-z",
    toolName: "ext.write",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "permission_denied");
  }
});

test("AC9d: executeTool runs handler when permission present", async () => {
  const reg = new ExtensionToolRegistry();
  reg.register({
    extensionId: "ext-w",
    definition: { name: "ext.write", description: "Write" },
    metadata: WRITE_METADATA,
    handler: async () => ({ ok: true, data: "wrote" }),
    grantedPermissions: ["tools:write_file"],
  });
  const result = await reg.executeTool("ext.write", {}, {
    extensionId: "ext-w",
    toolName: "ext.write",
  });
  assert.equal(result.ok, true);
});
