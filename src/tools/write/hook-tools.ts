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
import type {
  CreateHookArgs,
  ListHooksArgs,
  UpdateHookArgs,
  ApproveHookArgs,
  UninstallHookArgs,
  ReloadHooksArgs,
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

export function handleReloadHooks(
  _args: ReloadHooksArgs,
  deps: HookToolDeps,
): { ok: boolean; loaded: number; registered: number } {
  const r = deps.lifecycle.reload();
  return { ok: true, loaded: r.loaded, registered: r.registered };
}