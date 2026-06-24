/**
 * ExtensionToolRegistry — runtime merge of extension-contributed
 * tools into the executor's tool space. This is the parallel of
 * `src/tools/mcp/registry.ts` (MergedToolRegistry), but for
 * first-party extensions rather than MCP servers.
 *
 * Two non-negotiable invariants:
 *
 *   1. Every registered tool has a `ToolMetadata` entry. The
 *      policy gate (`evaluateToolCall`) requires metadata; without
 *      it, the tool is denied with `code: "no_metadata"`.
 *
 *   2. `executeTool` consults the permission manager before
 *      invoking the handler. A tool without permission returns
 *      `{ ok: false, code: "permission_denied" }`.
 *
 * The executor at `src/tools/executor.ts` calls `hasTool` to decide
 * whether a name is dispatchable, and `executeTool` to run it. No
 * other module should touch the underlying map directly.
 */

import type { ToolMetadata } from "../governance/tool-metadata.js";
import type { ExtensionPermission } from "./types.js";
import type { ExtensionPermissionLike } from "./permission-manager.js";
import { ExtensionPermissionManager } from "./permission-manager.js";

/** Handler signature mirrors the executor's `execute` contract. */
export type ExtensionToolHandler = (
  args: Record<string, unknown>,
  ctx: ExtensionToolContext,
) => Promise<unknown> | unknown;

export interface ExtensionToolContext {
  extensionId: string;
  toolName: string;
  callId?: string;
}

export interface ExtensionToolDefinition {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
}

export interface ExtensionToolRecord {
  extensionId: string;
  definition: ExtensionToolDefinition;
  metadata: ToolMetadata;
  handler: ExtensionToolHandler;
  /** The permission needed to call this tool. Derived from metadata
   *  but stored here for fast lookup. */
  requiredPermission: ExtensionPermission;
}

export interface ExtensionToolStats {
  total: number;
  byExtension: Record<string, number>;
}

/**
 * Map an extension tool's name + description into the closest
 * permission. Conservative: anything that smells like a write or
 * shell falls into the highest-risk bucket we have.
 */
export function deriveRequiredPermission(name: string, metadata: ToolMetadata): ExtensionPermission {
  if (metadata.can_execute_code) {
    // Shell commands go through `run_shell_command`, but extension
    // tools that can execute code are higher-risk than read tools.
    if (metadata.risk_level === "high" || metadata.risk_level === "critical") return "shell:high";
    if (metadata.risk_level === "medium") return "shell:medium";
    return "shell:low";
  }
  if (metadata.can_modify_files) {
    if (metadata.risk_level === "critical") return "tools:delete_file";
    return "tools:write_file";
  }
  if (metadata.can_affect_host) return "tools:network";
  return "tools:read_file";
}

export class ExtensionToolRegistry {
  private readonly records = new Map<string, ExtensionToolRecord>();
  /** Tool name → list of permission records the install pipeline
   *  recorded. Used by `registerMetadataFor` and `doctor`. */
  private readonly metadataIndex = new Map<string, ToolMetadata>();
  private readonly permissions: ExtensionPermissionManager;

  constructor(permissions?: ExtensionPermissionManager) {
    this.permissions = permissions ?? new ExtensionPermissionManager();
  }

  /**
   * Register a tool. The `metadata` is REQUIRED — a tool without
   * metadata is rejected and the caller must fix the extension.
   */
  register(input: {
    extensionId: string;
    definition: ExtensionToolDefinition;
    metadata: ToolMetadata;
    handler: ExtensionToolHandler;
    grantedPermissions?: ExtensionPermissionLike[];
  }): { ok: true } | { ok: false; error: string } {
    if (!input.metadata || typeof input.metadata !== "object") {
      return { ok: false, error: "metadata is required (policy gate will deny `no_metadata`)" };
    }
    if (input.metadata.name !== input.definition.name) {
      return { ok: false, error: `metadata.name ("${input.metadata.name}") must equal definition.name ("${input.definition.name}")` };
    }
    if (this.records.has(input.definition.name)) {
      return { ok: false, error: `tool "${input.definition.name}" is already registered` };
    }
    const required = deriveRequiredPermission(input.definition.name, input.metadata);
    this.records.set(input.definition.name, {
      extensionId: input.extensionId,
      definition: input.definition,
      metadata: input.metadata,
      handler: input.handler,
      requiredPermission: required,
    });
    this.metadataIndex.set(input.definition.name, input.metadata);
    if (input.grantedPermissions && input.grantedPermissions.length > 0) {
      this.permissions.grant(input.extensionId, input.grantedPermissions);
    }
    return { ok: true };
  }

  /** Convenience used by the install pipeline: register metadata
   *  before activation so the policy gate sees it on first call. */
  registerMetadataFor(extensionId: string, metadataList: ToolMetadata[]): void {
    for (const m of metadataList) {
      this.metadataIndex.set(m.name, m);
      // The policy gate looks at metadata directly; recording the
      // extension id lets `doctor` answer "which extension owns
      // this tool".
      (m as ToolMetadata & { _ownerExtensionId?: string })._ownerExtensionId = extensionId;
    }
  }

  unregister(toolName: string): boolean {
    this.metadataIndex.delete(toolName);
    return this.records.delete(toolName);
  }

  unregisterAllForExtension(extensionId: string): number {
    let removed = 0;
    for (const [name, r] of this.records) {
      if (r.extensionId === extensionId) {
        this.records.delete(name);
        this.metadataIndex.delete(name);
        removed++;
      }
    }
    return removed;
  }

  hasTool(name: string): boolean {
    return this.records.has(name);
  }

  getMetadata(name: string): ToolMetadata | undefined {
    return this.metadataIndex.get(name);
  }

  getDefinition(name: string): ExtensionToolDefinition | undefined {
    return this.records.get(name)?.definition;
  }

  listTools(): string[] {
    return [...this.records.keys()];
  }

  getStats(): ExtensionToolStats {
    const byExtension: Record<string, number> = {};
    let total = 0;
    for (const r of this.records.values()) {
      byExtension[r.extensionId] = (byExtension[r.extensionId] ?? 0) + 1;
      total++;
    }
    return { total, byExtension };
  }

  /** Return the permission manager for advanced callers. */
  getPermissions(): ExtensionPermissionManager {
    return this.permissions;
  }

  /**
   * Execute a tool by name. Consults the permission manager
   * BEFORE invoking the handler; a denied tool returns
   * `{ ok: false, code: "permission_denied" }` and never invokes.
   */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ExtensionToolContext,
  ): Promise<{ ok: true; value: unknown } | { ok: false; code: string; error: string }> {
    const record = this.records.get(name);
    if (!record) return { ok: false, code: "unknown_tool", error: `extension tool "${name}" is not registered` };
    if (!this.permissions.check(record.extensionId, record.requiredPermission)) {
      return {
        ok: false,
        code: "permission_denied",
        error: `extension "${record.extensionId}" lacks permission "${record.requiredPermission}"`,
      };
    }
    try {
      const out = await record.handler(args, ctx);
      return { ok: true, value: out };
    } catch (e) {
      return {
        ok: false,
        code: "tool_error",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
