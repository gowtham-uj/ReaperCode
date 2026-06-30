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

test("AC9e: executeTool times out hung extension tools", async () => {
  const reg = new ExtensionToolRegistry({ defaultToolTimeoutMs: 20 });
  reg.register({
    extensionId: "ext-timeout",
    definition: { name: "ext.read", description: "Slow read" },
    metadata: READ_METADATA,
    handler: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1_000)),
    grantedPermissions: ["tools:read_file"],
  });

  const started = Date.now();
  const result = await reg.executeTool("ext.read", {}, {
    extensionId: "ext-timeout",
    toolName: "ext.read",
  });

  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 500, "timeout should bound the hung handler");
  if (!result.ok) {
    assert.equal(result.code, "tool_timeout");
    assert.match(result.error, /timed out after 20ms/);
  }
});

test("AC9f: executeTool passes an abort signal to cooperative extension tools", async () => {
  const reg = new ExtensionToolRegistry({ defaultToolTimeoutMs: 20 });
  let observedSignal: AbortSignal | undefined;
  reg.register({
    extensionId: "ext-abort",
    definition: { name: "ext.read", description: "Cooperative read" },
    metadata: READ_METADATA,
    handler: (_args, ctx) => {
      observedSignal = ctx.signal;
      return new Promise((resolve, reject) => {
        ctx.signal?.addEventListener("abort", () => reject(new Error("observed abort")), { once: true });
        setTimeout(() => resolve({ ok: true }), 1_000);
      });
    },
    grantedPermissions: ["tools:read_file"],
  });

  const result = await reg.executeTool("ext.read", {}, {
    extensionId: "ext-abort",
    toolName: "ext.read",
  });

  assert.ok(observedSignal, "handler should receive an AbortSignal");
  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "tool_timeout");
  }
});

test("AC9g: executeTool validates args against extension tool schema before invoking handler", async () => {
  const reg = new ExtensionToolRegistry();
  let invoked = false;
  reg.register({
    extensionId: "ext-schema",
    definition: {
      name: "ext.read",
      description: "Schema read",
      schema: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          limit: { type: "integer" },
        },
      },
    },
    metadata: READ_METADATA,
    handler: async () => {
      invoked = true;
      return { ok: true };
    },
    grantedPermissions: ["tools:read_file"],
  });

  const missing = await reg.executeTool("ext.read", { limit: 10 }, {
    extensionId: "ext-schema",
    toolName: "ext.read",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "schema_error");
    assert.match(missing.error, /missing required property 'path'/);
  }

  const wrongType = await reg.executeTool("ext.read", { path: "README.md", limit: "10" }, {
    extensionId: "ext-schema",
    toolName: "ext.read",
  });
  assert.equal(wrongType.ok, false);
  if (!wrongType.ok) {
    assert.equal(wrongType.code, "schema_error");
    assert.match(wrongType.error, /limit must be integer/);
  }

  const extra = await reg.executeTool("ext.read", { path: "README.md", extra: true }, {
    extensionId: "ext-schema",
    toolName: "ext.read",
  });
  assert.equal(extra.ok, false);
  if (!extra.ok) {
    assert.equal(extra.code, "schema_error");
    assert.match(extra.error, /unexpected property 'extra'/);
  }
  assert.equal(invoked, false);

  const ok = await reg.executeTool("ext.read", { path: "README.md", limit: 10 }, {
    extensionId: "ext-schema",
    toolName: "ext.read",
  });
  assert.equal(ok.ok, true);
  assert.equal(invoked, true);
});
