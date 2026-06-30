/**
 * AC16: No extension bypasses PermissionManager.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionToolRegistry } from "../../../src/extensions/tool-registry.js";
import type { ToolMetadata } from "../../../src/governance/tool-metadata.js";

const ALL_ROLES = ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"] as const;
const READ: ToolMetadata = {
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

test("AC16: extension tools refuse execution when permission is missing", async () => {
  const reg = new ExtensionToolRegistry();
  reg.register({
    extensionId: "ext",
    definition: { name: "ext.read", description: "x" },
    metadata: READ,
    handler: async () => ({ secret: "x" }),
  });
  const result = await reg.executeTool("ext.read", {}, { extensionId: "ext", toolName: "ext.read" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "permission_denied");
});

test("AC16b: unknown extension tools return unknown_tool code", async () => {
  const reg = new ExtensionToolRegistry();
  const result = await reg.executeTool("missing.tool", {}, { extensionId: "x", toolName: "missing.tool" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unknown_tool");
});

test("AC16c: register() requires metadata", () => {
  const reg = new ExtensionToolRegistry();
  const result = reg.register({
    extensionId: "ext",
    definition: { name: "ext.x", description: "x" },
    metadata: undefined as unknown as ToolMetadata,
    handler: async () => ({}),
  });
  assert.equal(result.ok, false);
});
