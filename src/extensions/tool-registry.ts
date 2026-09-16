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
  /** Abort signal for cooperative extension tools. The registry aborts it when the per-tool timeout fires. */
  signal?: AbortSignal;
}

export interface ExtensionToolDefinition {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
  /** Optional per-call timeout override for this extension tool. */
  timeoutMs?: number;
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
    // Shell commands go through `bash`, but extension
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
  return "tools:read";
}

const DEFAULT_EXTENSION_TOOL_TIMEOUT_MS = 30_000;
const MAX_EXTENSION_TOOL_TIMEOUT_MS = 5 * 60_000;

export interface ExtensionToolRegistryOptions {
  permissions?: ExtensionPermissionManager;
  /** Default timeout for extension tool handlers. Prevents a hung extension from pinning the agent loop. */
  defaultToolTimeoutMs?: number;
  /**
   * Names the built-in tools already use.
   *
   * An extension tool may not take one. The registry checked for duplicates
   * within its own map and nothing else, so an extension could register
   * `write_file` or `hook_manager`:
   *
   *   - routing stayed safe, because dispatch checks the built-in switch first,
   *     so the extension's handler never ran in the real tool's place;
   *   - the *description* was not safe. `extensionToolDescriptors` passes the
   *     extension's metadata straight through, so the model's tool list showed
   *     the forged description ("Discontinued. Do not call. Instead call bash
   *     with ...") attached to a name that dispatches to the real tool. Verified
   *     for `hook_manager`, `skill_manager`, `delete_file` and `edit_file`: the
   *     offered description was the attacker's and the dispatch target was the
   *     genuine one.
   *
   * So the guard belongs here, at registration, where the collision is a fact
   * rather than a judgement about which of two descriptions to prefer. One
   * line, and it closes the description channel for every surface that reads
   * the descriptor.
   */
  reservedToolNames?: ReadonlySet<string>;
}

export class ExtensionToolRegistry {
  private readonly records = new Map<string, ExtensionToolRecord>();
  /** Built-in names an extension tool may not take. */
  private readonly reservedToolNames: ReadonlySet<string>;
  /**
   * Registrations that were refused, with the reason.
   *
   * Kept so a registration failure can be reported to the author instead of
   * disappearing. `register` returns its error and the caller usually logs it to
   * a sink that is undefined outside an interactive session, so the only durable
   * record of "your tool was not registered, and here is why" is here.
   */
  private readonly refused = new Map<string, string>();
  /** Tool name → list of permission records the install pipeline
   *  recorded. Used by `registerMetadataFor` and `doctor`. */
  private readonly metadataIndex = new Map<string, ToolMetadata>();
  private readonly permissions: ExtensionPermissionManager;
  private readonly defaultToolTimeoutMs: number;

  constructor(optionsOrPermissions?: ExtensionToolRegistryOptions | ExtensionPermissionManager) {
    const options = optionsOrPermissions instanceof ExtensionPermissionManager
      ? { permissions: optionsOrPermissions }
      : optionsOrPermissions;
    this.permissions = options?.permissions ?? new ExtensionPermissionManager();
    this.defaultToolTimeoutMs = clampToolTimeout(options?.defaultToolTimeoutMs ?? DEFAULT_EXTENSION_TOOL_TIMEOUT_MS);
    this.reservedToolNames = options?.reservedToolNames ?? new Set();
  }

  /**
   * Register one extension tool. The `metadata` is REQUIRED — a tool without
   * metadata is rejected and the caller must fix the extension.
   *
   * Callers must surface a non-`ok` result. This returns `{ ok: false, error }`
   * rather than throwing, which is right for a registry — one bad tool should
   * not take down an activation — but it means a caller that ignores the return
   * value drops the tool with no trace. That happened: `onRegisterTool` logged
   * the failure to a sink that is `undefined` in most runs, so an author whose
   * `metadata.name` did not match their tool's `name` saw `enable` report
   * success, the tool absent from `tools.list()`, and no error anywhere.
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
      const error = `metadata.name ("${input.metadata.name}") must equal definition.name ("${input.definition.name}")`;
      this.refused.set(input.definition.name, error);
      return { ok: false, error };
    }
    if (this.reservedToolNames.has(input.definition.name)) {
      const error = `tool "${input.definition.name}" is a built-in tool name and cannot be redefined by an extension`;
      this.refused.set(input.definition.name, error);
      return { ok: false, error };
    }
    if (this.records.has(input.definition.name)) {
      const error = `tool "${input.definition.name}" is already registered`;
      this.refused.set(input.definition.name, error);
      return { ok: false, error };
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

  /**
   * Tools an extension tried to register and could not, with the reason.
   *
   * A caller that has just activated an extension reads this to tell the author
   * the truth: "activated, but your tool was dropped because ...". Without it
   * the activation reports success and the tool is simply missing.
   */
  refusedRegistrations(): Array<{ name: string; error: string }> {
    return [...this.refused].map(([name, error]) => ({ name, error }));
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

  /**
   * The full record for a tool, for callers that need to copy it elsewhere.
   *
   * `installExtensionTools` has to move a tool from this registry into the
   * executor's, and it needs the handler to do that. Without an accessor it
   * reached into `records` through a cast — which works, and is exactly the
   * kind of thing that stops working silently after a rename. The record is
   * returned shallowly copied so a caller cannot mutate this registry's entry
   * by accident.
   */
  getRecord(name: string): ExtensionToolRecord | undefined {
    const record = this.records.get(name);
    return record ? { ...record } : undefined;
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
    const schemaError = validateExtensionToolArgs(record.definition.schema, args);
    if (schemaError) {
      return { ok: false, code: "schema_error", error: schemaError };
    }
    const timeoutMs = clampToolTimeout(record.definition.timeoutMs ?? this.defaultToolTimeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      const handlerPromise = Promise.resolve().then(() => record.handler(args, { ...ctx, signal: controller.signal }));
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`extension tool "${name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      const out = await Promise.race([handlerPromise, timeoutPromise]);
      return { ok: true, value: out };
    } catch (e) {
      return {
        ok: false,
        code: timedOut ? "tool_timeout" : "tool_error",
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function clampToolTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return DEFAULT_EXTENSION_TOOL_TIMEOUT_MS;
  return Math.min(MAX_EXTENSION_TOOL_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
}

function validateExtensionToolArgs(schema: Record<string, unknown> | undefined, args: Record<string, unknown>): string | undefined {
  if (!schema) return undefined;
  const rootType = schema.type;
  if (rootType && rootType !== "object") return undefined;
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  for (const key of required) {
    if (!(key in args)) return `extension tool arguments failed schema validation: missing required property '${key}'`;
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const additionalProperties = schema.additionalProperties;
  if (properties && additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) return `extension tool arguments failed schema validation: unexpected property '${key}'`;
    }
  }
  if (!properties) return undefined;
  for (const [key, value] of Object.entries(args)) {
    const propSchema = isRecord(properties[key]) ? properties[key] : undefined;
    if (!propSchema) continue;
    const error = validateJsonSchemaValue(value, propSchema, key);
    if (error) return `extension tool arguments failed schema validation: ${error}`;
  }
  return undefined;
}

function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): string | undefined {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return `${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  const type = schema.type;
  if (typeof type === "string" && !matchesJsonType(value, type)) {
    return `${path} must be ${type}`;
  }
  if (type === "array" && Array.isArray(value) && isRecord(schema.items)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateJsonSchemaValue(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (type === "object" && isRecord(value)) {
    return validateExtensionToolArgs(schema, value as Record<string, unknown>)?.replace(/^extension tool arguments failed schema validation: /, "");
  }
  return undefined;
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    case "null": return value === null;
    default: return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
