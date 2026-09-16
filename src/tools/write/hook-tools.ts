/**
 * Hook authoring tool handlers — the 6 model-callable tools that
 * exercise HookLifecycle.
 *
 *   create_hook      → lifecycle.create (persisted and live)
 *   list_hooks       → lifecycle.list (read-only inventory)
 *   update_hook      → lifecycle.update (re-compile, re-register)
 *   approve_hook     → lifecycle.approve (a no-op; already live)
 *   uninstall_hook   → lifecycle.uninstall (remove from disk and runner)
 *   reload_hooks     → lifecycle.reload (re-walk the disk)
 *
 * `create_hook` asks before it writes, and that header used to say the
 * opposite: "No approval gate. Hooks have no trust tiers: a hook is live the
 * moment it is written." That was true and it was the largest hole in the
 * codebase, one layer below the sandbox.
 *
 * A hook's source is compiled with `new Function` and run in the app-server
 * process, as root, with `ANTHROPIC_AUTH_TOKEN` in scope. Measured: `uid=0`,
 * `child_process` available, the token readable from `process.env`, and the
 * handler's return value lands in the transcript so the model reads it back.
 * Exfiltration needs no network because the model is the channel. It also
 * persists: a hook authored in one session is loaded from disk and fires in the
 * next.
 *
 * Extensions were given an approval gate on create and enable for exactly this
 * reason. Hooks had nothing, which left the cheaper path open: `create_hook`
 * with a source that runs on the next tool call, unattended.
 *
 * `approve_hook` is still a no-op and still reports success. It was never the
 * gate, and a caller written against it keeps working; the gate is here, at the
 * write, which is the only point where asking changes anything.
 *
 * Enforce flag: `enforce: false` (default) makes the hook
 * observation-only — `allow: false` is ignored at dispatch time
 * and only `message` is surfaced as a hint to the model. `enforce:
 * true` lets the hook block tool calls. This is a capability flag,
 * not a trust one.
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

/**
 * How a hook write asks the user first.
 *
 * Shaped like the extension requester rather than sharing its type, because the
 * two answer different questions: an extension's gate is about code that is
 * loaded as a module with its own lifecycle, and a hook's is about a snippet
 * that runs on every matching tool call. Sharing one type would mean one
 * description for both, and the sentence a user reads is the whole control.
 */
export type HookApprovalRequester = (input: {
  kind: "create_hook" | "update_hook";
  id: string;
  description: string;
  /** Whether the hook can block tool calls, which is worth saying separately. */
  enforce: boolean;
  scope: string;
  /**
   * The tool arguments this approval is about, verbatim.
   *
   * The approval surface renders the call, and a `create` is only a call with
   * all of `event`, `description`, `source`, `enforce` and `scope` present, so
   * a summary assembled by the gate would not be the request being approved.
   * The handler has the real arguments, so it passes them through unchanged.
   */
  rawArgs?: unknown;
}) => Promise<boolean>;

export interface HookToolDeps {
  lifecycle: HookLifecycle;
  /**
   * How the run asks the user to approve a hook.
   *
   * Optional because tests and direct callers legitimately build these handlers
   * without an approval surface; when it is absent the gate is skipped rather
   * than every call failing. The app-server supplies one, which is what makes
   * the gate real in the path a model actually takes.
   */
  approvalRequester?: HookApprovalRequester | undefined;
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
  /*
   * Before the write, not after: a denied create must leave nothing on disk and
   * nothing registered. `lifecycle.create` both persists and registers on the
   * live runner, so asking afterwards would mean the code was already live when
   * the question was asked.
   */
  if (deps.approvalRequester) {
    const allowed = await deps.approvalRequester({
      kind: "create_hook",
      id: args.id,
      description: args.description,
      enforce: args.enforce,
      scope: args.scope,
      rawArgs: args,
    });
    if (!allowed) return { ok: false, id: args.id, error: "denied by approval gate" };
  }
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
    scope: r.scope,
    timeout_ms: r.timeout_ms,
    /*
     * Reported from the runner, not from the `trust` label.
     *
     * `compiled` and `registered` were both `r.trust !== "draft"`, which is a
     * copy of one field printed twice. It said a hook was live because a string
     * in its JSON said so. This asks the subscription map instead, so the
     * inventory cannot disagree with what will actually run. A hook whose
     * source fails to compile reads `registered: false`, which is true and
     * worth knowing.
     */
    registered: deps.lifecycle.isRegistered(r.id),
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
  /*
   * A new source is the same power as a create, so it asks the same question.
   *
   * Gating create alone left the obvious way around it: create a hook whose
   * source does nothing, then update it to one that does. The description, the
   * matcher and the timeout are metadata and go through ungated, because asking
   * about a sentence change trains the user to click through the prompt that
   * matters.
   */
  if (deps.approvalRequester && args.source !== undefined) {
    const allowed = await deps.approvalRequester({
      kind: "update_hook",
      id: args.id,
      description: args.description ?? `rewrite the source of hook "${args.id}"`,
      enforce: args.enforce ?? true,
      scope: "existing",
      rawArgs: args,
    });
    if (!allowed) return { ok: false, error: "denied by approval gate" };
  }
  const input: UpdateHookInput = { id: args.id };
  if (args.description !== undefined) input.description = args.description;
  if (args.event !== undefined) input.event = args.event;
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
      /*
       * The full args, not `requireHookId(args, "update")`.
       *
       * `requireHookId` returns `{ id }` and nothing else, so calling it here
       * meant `handleUpdateHook` saw `source`, `matcher`, `timeout_ms`,
       * `enforce`, `description` and `event` as `undefined` no matter what the
       * caller supplied. Every `update` bumped `updatedAt` and returned
       * `ok: true` while changing nothing, which is the worst shape for a bug:
       * it reports success. `requireHookId` is the right guard for `approve`
       * and `uninstall`, which take nothing but an id; `update` has fields to
       * carry, so it validates the id separately and keeps them.
       */
      return handleUpdateHook(withRequiredHookId(args, "update"), deps);
    case "approve":
      return handleApproveHook(requireHookId(args, "approve"), deps);
    case "uninstall":
      return handleUninstallHook(requireHookId(args, "uninstall"), deps);
  }
}

function requireHookId(args: HookManagerArgs, action: string): ApproveHookArgs & UninstallHookArgs {
  const id = "id" in args && typeof args.id === "string" ? args.id : "";
  if (!id) throw new Error(`hook_manager action="${action}" requires "id"`);
  return { id };
}

/**
 * `update` needs the id enforced but the other fields preserved.
 *
 * `requireHookId` builds a fresh `{ id }`, which is right for `approve` and
 * `uninstall` and wrong for `update`: the caller's `source`, `matcher`,
 * `description`, `event`, `timeout_ms` and `enforce` all have to survive into
 * the handler. This validates the id and otherwise returns the args unchanged.
 */
function withRequiredHookId(args: HookManagerArgs, action: string): UpdateHookArgs {
  const id = "id" in args && typeof args.id === "string" ? args.id : "";
  if (!id) throw new Error(`hook_manager action="${action}" requires "id"`);
  return args as UpdateHookArgs;
}