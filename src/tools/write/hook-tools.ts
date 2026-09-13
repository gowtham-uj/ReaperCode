/**
 * Hook authoring tool handlers — the 6 model-callable tools that
 * exercise HookLifecycle.
 *
 *   create_hook      → lifecycle.create (draft on disk; not registered)
 *   list_hooks       → lifecycle.list (read-only inventory)
 *   update_hook      → lifecycle.update (re-compile, re-register)
 *   approve_hook     → approval gate + lifecycle.approve (compile + register)
 *   uninstall_hook   → approval gate + lifecycle.uninstall
 *   reload_hooks     → lifecycle.reload (re-walk the disk)
 *
 * The lifecycle already routes through the approval requester
 * configured on `HookLifecycleOptions.approvalRequester`. The
 * handlers pass no extra gate; the wiring step injects the runtime
 * approval requester into the lifecycle at construction time.
 *
 * Enforce flag: `enforce: false` (default) makes the hook
 * observation-only — `allow: false` is ignored at dispatch time
 * and only `message` is surfaced as a hint to the model. `enforce:
 * true` lets the hook block tool calls (still requires the
 * approval gate).
 */

import type {
  HookLifecycle,
  HookRecord,
  HookMatcher,
  UpdateHookInput,
} from "../../hooks/lifecycle.js";
import type { HookEventName } from "../../extensions/types.js";
import { CreateHookArgsSchema } from "../types/hook-tools.schema.js";
import { operationArgs } from "../types/manager-args.js";
import type {
  CreateHookArgs,
  ListHooksArgs,
  UpdateHookArgs,
  ApproveHookArgs,
  UninstallHookArgs,
  HookManagerArgs,
} from "../types/hook-tools.schema.js";

export interface HookToolDeps {
  lifecycle: HookLifecycle;
}

export interface CreateHookResult {
  ok: boolean;
  id?: string;
  record?: HookRecord;
  error?: string;
}

export async function handleCreateHook(
  args: CreateHookArgs,
  deps: HookToolDeps,
): Promise<CreateHookResult> {
  const out = deps.lifecycle.create({
    id: args.id,
    event: args.event as HookEventName,
    description: args.description,
    matcher: (args.matcher ?? null) as HookMatcher | null,
    source: args.source,
    ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
    enforce: args.enforce,
    scope: args.scope,
  });
  if (!out.ok || !out.record) return { ok: false, ...(out.error ? { error: out.error } : {}) };
  return { ok: true, id: out.record.id, record: out.record };
}

export function handleListHooks(
  args: ListHooksArgs,
  deps: HookToolDeps,
): { ok: boolean; scope: string; hooks: Array<Record<string, unknown>> } {
  const all = deps.lifecycle.list();
  const filtered = args.scope === "all" ? all : all.filter((r) => r.scope === args.scope);
  const items = filtered.map((r) => ({
    id: r.id,
    event: r.event,
    description: r.description,
    matcher: r.matcher,
    enforce: r.enforce,
    trust: r.trust,
    scope: r.scope,
    timeout_ms: r.timeout_ms,
    compiled: r.trust !== "draft",
    registered: r.trust !== "draft",
    sourceBytes: r.source.length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return { ok: true, scope: args.scope, hooks: items };
}

export async function handleUpdateHook(
  args: UpdateHookArgs,
  deps: HookToolDeps,
): Promise<{ ok: boolean; record?: HookRecord; error?: string }> {
  const input: UpdateHookInput = { id: args.id };
  if (args.source !== undefined) input.source = args.source;
  if (args.matcher !== undefined) input.matcher = (args.matcher ?? null) as HookMatcher | null;
  if (args.timeout_ms !== undefined) input.timeout_ms = args.timeout_ms;
  if (args.enforce !== undefined) input.enforce = args.enforce;
  return deps.lifecycle.update(input);
}

export async function handleApproveHook(
  args: ApproveHookArgs,
  deps: HookToolDeps,
): Promise<{ ok: boolean; record?: HookRecord; error?: string }> {
  return deps.lifecycle.approve(args.id);
}

export async function handleUninstallHook(
  args: UninstallHookArgs,
  deps: HookToolDeps,
): Promise<{ ok: boolean; error?: string }> {
  return deps.lifecycle.uninstall(args.id);
}

/**
 * The one hook tool the model calls. Dispatches on `action` to the handlers
 * above; they stay separate because they are the unit the existing tests
 * exercise.
 *
 * There is no `reload` action — see the schema header for why.
 */
export async function handleHookManager(
  args: HookManagerArgs,
  deps: HookToolDeps,
): Promise<unknown> {
  // `reload_hooks` is gone, so the manager re-walks the install dirs itself
  // before every action. `discover()` is idempotent — it re-reads each
  // `<id>.json`, refreshes `records`, and registers any trusted hook that is
  // not already subscribed — so a hook file dropped in by hand is live for
  // `list` and `approve` without a separate reload step. `reload()` is
  // deliberately not used here: it wipes and rebuilds the runner subscriptions,
  // which would drop and re-add every hook on every call for no gain.
  deps.lifecycle.discover();
  switch (args.action) {
    case "create": {
      // `scope` stays in: it is a create field, and the manager's wider enum
      // (`all` is the `list` filter) is what the strict re-parse narrows.
      const parsed = CreateHookArgsSchema.safeParse(operationArgs(args));
      if (!parsed.success) {
        return { ok: false, action: args.action, error: `create requires the full hook definition: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
      }
      return handleCreateHook(parsed.data, deps);
    }
    case "list": {
      const scope = args.scope === "project" || args.scope === "user" ? args.scope : "all";
      return handleListHooks({ scope }, deps);
    }
    case "update":
      return handleUpdateHook(requireHookId(args, "update"), deps);
    case "approve":
      return handleApproveHook(requireHookId(args, "approve"), deps);
    case "uninstall":
      return handleUninstallHook(requireHookId(args, "uninstall"), deps);
  }
}

function requireHookId(args: HookManagerArgs, action: string): UpdateHookArgs & ApproveHookArgs & UninstallHookArgs {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw new Error(`hook_manager action="${action}" requires "id"`);
  return { id };
}