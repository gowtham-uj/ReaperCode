/**
 * Extension authoring tool handlers — the 6 model-callable tools
 * that exercise ExtensionLifecycle + ExtensionRegistry.
 *
 *   create_extension      → write manifest + main.js, install as project-untrusted
 *   validate_extension    → run validation.commands (best-effort)
 *   enable_extension      → registry.enable + activateOne + wire tools into executor
 *   trust_extension       → approval gate + registry.trust_
 *   uninstall_extension   → approval gate + registry.uninstall
 *   reload_extensions     → registry.discover
 *
 * JS-only: `create_extension` enforces `.js` for `main` and refuses
 * to compile or load anything else. The runtime cannot route a TS
 * file through to the executor because the manifest normalizer
 * already rejects `.ts` (see `src/extensions/manifest.ts:88`).
 *
 * Hot-reload: `enable_extension` calls
 * `ToolExecutor.refreshExtensionTools(registry)` so the new tools
 * appear in dispatch on the next turn.
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

import type { ExtensionLifecycle } from "../../extensions/lifecycle.js";
import type { ExtensionRegistry } from "../../extensions/registry.js";
import type {
  ExtensionContributions,
  ExtensionHookContribution,
  ExtensionManifest,
  ExtensionToolContribution,
  ExtensionSlashCommandContribution,
} from "../../extensions/types.js";
import type { HookEventName } from "../../extensions/types.js";
import { writeExtensionManifest } from "../../extensions/manifest.js";
import { CreateExtensionArgsSchema } from "../types/extension-tools.schema.js";
import { operationArgs } from "../types/manager-args.js";
import type {
  CreateExtensionArgs,
  ValidateExtensionArgs,
  EnableExtensionArgs,
  TrustExtensionArgs,
  UninstallExtensionArgs,
  ExtensionManagerArgs,
} from "../types/extension-tools.schema.js";

export type ExtensionApprovalRequester = (input: {
  kind: "trust_extension" | "uninstall_extension";
  id: string;
  description: string;
  trust: string;
}) => Promise<boolean> | boolean;

export interface ExtensionToolDeps {
  lifecycle: ExtensionLifecycle;
  registry: ExtensionRegistry;
  workspaceRoot: string;
  userHome: string;
  approvalRequester?: ExtensionApprovalRequester;
  /**
   * Backdoor on ToolExecutor — called after a successful enable
   * to copy the extension's tools into the live executor dispatch.
   * Optional because the test harness may exercise handlers in
   * isolation.
   */
  refreshExtensionTools?: () => Promise<void> | void;
}

export interface CreateExtensionResult {
  ok: boolean;
  id?: string;
  installPath?: string;
  trust?: string;
  error?: string;
}

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

export async function handleCreateExtension(
  args: CreateExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<CreateExtensionResult> {
  if (!ID_REGEX.test(args.id)) return { ok: false, error: `id "${args.id}" must match ${ID_REGEX.source}` };
  if (/\.ts$/i.test(args.main) || /\.tsx$/i.test(args.main)) {
    return { ok: false, error: `extensions are JavaScript-only (got "${args.main}"); rename to .js` };
  }
  if (args.source.length === 0) {
    return { ok: false, error: `source is required for main.js (extensions are JS only)` };
  }
  const targetRoot = args.scope === "user"
    ? join(deps.userHome, ".reaper", "extensions")
    : join(deps.workspaceRoot, ".reaper", "extensions");
  const targetDir = join(targetRoot, args.id);
  if (existsSync(targetDir)) return { ok: false, id: args.id, installPath: targetDir, error: `extension already installed at ${targetDir}` };

  const contributes: ExtensionContributions = {};
  if (args.tools) {
    const tools: ExtensionToolContribution[] = args.tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.schema ? { schema: t.schema } : {}),
    }));
    contributes.tools = tools;
  }
  if (args.hooks_declared) {
    contributes.hooks = args.hooks_declared.map((h): ExtensionHookContribution => ({
      event: h.event as HookEventName,
      ...(h.timeout_ms !== undefined ? { timeoutMs: h.timeout_ms } : {}),
    }));
  }
  if (args.slash_commands) {
    const cmds: ExtensionSlashCommandContribution[] = args.slash_commands.map((s) => ({
      name: s.name,
      description: s.description,
    }));
    contributes.slashCommands = cmds;
  }
  const manifest: ExtensionManifest = {
    id: args.id,
    version: args.version,
    description: args.description,
    main: args.main,
    engines: { reaper: args.engines_reaper },
    permissions: args.permissions,
    ...(Object.keys(contributes).length > 0 ? { contributes } : {}),
  };

  // Stage the extension in a tmp dir so ExtensionRegistry.install
  // can copy it into the final install location. We can't write
  // directly into targetDir because install() refuses an already-
  // populated target.
  const stagingDir = join(targetRoot, `.staging-${args.id}-${Date.now()}`);
  try {
    mkdirSync(stagingDir, { recursive: true });
    // Sanity-check the manifest by writing through the normalizer.
    writeExtensionManifest(manifest, stagingDir);
    // Write the JS source for main.
    const mainPath = join(stagingDir, basename(args.main));
    writeFileSync(mainPath, args.source, "utf8");
  } catch (e) {
    if (existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: false, id: args.id, error: e instanceof Error ? e.message : String(e) };
  }

  // Register via the registry but as project-untrusted (no human approval yet).
  const r = deps.registry.install({ srcPath: stagingDir, scope: args.scope, trust: false });
  // Cleanup the staging dir; install() copies into targetDir.
  if (existsSync(stagingDir)) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!r.ok) {
    if (existsSync(targetDir)) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: false, id: args.id, installPath: targetDir, ...(r.error ? { error: r.error } : {}) };
  }
  const loaded = deps.registry.get(args.id);
  return {
    ok: true,
    id: args.id,
    installPath: targetDir,
    trust: loaded?.trust ?? "project-untrusted",
  };
}

/**
 * `list` — inventory plus the refused registrations.
 *
 * The authoring skill tells an author to run `extension_manager list` to see
 * the `refused` list after creating an extension, but the action was never in
 * the enum, so the tool rejected the call it was documented to serve. The
 * refused list is the only durable record of "your tool was dropped, and here is
 * why" — `register` logs the failure to a sink that is undefined outside an
 * interactive session — so the action the doc depends on is the right thing to
 * add, not the line to delete.
 */
export async function handleListExtensions(
  deps: ExtensionToolDeps,
): Promise<{ ok: true; extensions: Array<{ id: string; trust: string; status: string; description: string }>; refused: Array<{ name: string; error: string }> }> {
  const extensions = deps.registry.list().map((e) => ({
    id: e.id,
    trust: e.trust,
    status: e.status,
    description: e.manifest.description ?? "",
  }));
  const refused = deps.registry.getToolRegistry().refusedRegistrations();
  return { ok: true, extensions, refused };
}

export async function handleValidateExtension(
  args: ValidateExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; results: Array<{ id: string; exitCode: number; stdout: string; stderr: string }>; error?: string; note?: string }> {
  return deps.lifecycle.validate(args.id);
}

export async function handleEnableExtension(
  args: EnableExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; activated: boolean; error?: string }> {
  const r = deps.registry.get(args.id);
  if (!r) return { ok: false, id: args.id, activated: false, error: `extension "${args.id}" not loaded` };
  /*
   * No trust gate.
   *
   * This refused anything whose trust was not `user-trusted` and told the caller
   * to "call trust_extension first" — an action that does not exist (the action
   * is `trust`). And for a project-scope extension the gate could never be
   * satisfied at all: `trust_` only flips the in-memory flag, `discover()` (which
   * every manager action runs first) rebuilds that flag from disk, and the trust
   * resolver deliberately refuses to persist a `user-trusted` record under the
   * project directory. So the whole path was: create reports `trust:
   * project-untrusted`, trust reports success but is discarded, enable fails and
   * names a verb that is not in the enum. An extension could be created and
   * never used.
   *
   * `activateAll` already dropped this gate with the same reasoning — "there are
   * no trust tiers: an installed extension activates when it is enabled" — and
   * left `enable` behind. This is that check catching up. `disable`/`enable`
   * remain, because switching something off is a real user intent.
   */
  const en = deps.registry.enable(args.id);
  if (!en.ok) return { ok: false, id: args.id, activated: false, ...(en.error ? { error: en.error } : {}) };
  const activated = await deps.registry.activateOne(r);
  if (!activated) {
    return { ok: false, id: args.id, activated: false, error: r.error ?? "activation failed" };
  }
  if (deps.refreshExtensionTools) {
    await deps.refreshExtensionTools();
  }
  return { ok: true, id: args.id, activated: true };
}

export async function handleTrustExtension(
  args: TrustExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; trust?: string; error?: string }> {
  const r = deps.registry.get(args.id);
  if (!r) return { ok: false, id: args.id, error: `extension "${args.id}" not loaded` };
  if (deps.approvalRequester) {
    const allowed = await deps.approvalRequester({
      kind: "trust_extension",
      id: args.id,
      description: r.manifest.description,
      trust: r.trust,
    });
    if (!allowed) return { ok: false, id: args.id, error: "denied by approval gate" };
  }
  const t = deps.registry.trust_(args.id, args.note);
  if (!t.ok) return { ok: false, id: args.id, ...(t.error ? { error: t.error } : {}) };
  return { ok: true, id: args.id, trust: "user-trusted" };
}

export async function handleUninstallExtension(
  args: UninstallExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; error?: string }> {
  const r = deps.registry.get(args.id);
  if (r && deps.approvalRequester) {
    const allowed = await deps.approvalRequester({
      kind: "uninstall_extension",
      id: args.id,
      description: r.manifest.description,
      trust: r.trust,
    });
    if (!allowed) return { ok: false, id: args.id, error: "denied by approval gate" };
  }
  const u = deps.registry.uninstall(args.id);
  if (!u.ok) return { ok: false, id: args.id, ...(u.error ? { error: u.error } : {}) };
  if (deps.refreshExtensionTools) {
    await deps.refreshExtensionTools();
  }
  return { ok: true, id: args.id };
}

/**
 * The one extension tool the model calls. Dispatches on `action` to the
 * handlers above; they stay separate because they are the unit the existing
 * tests exercise.
 *
 * There is no `reload` action — see the schema header for why.
 */
export async function handleExtensionManager(
  args: ExtensionManagerArgs,
  deps: ExtensionToolDeps,
): Promise<unknown> {
  // `reload_extensions` is gone, so the manager re-walks the install dirs
  // itself before every action. The walk is a directory read plus a JSON parse
  // per manifest, it is idempotent, and it is the difference between acting on
  // what is on disk and acting on what this process happened to load at boot —
  // an extension copied in by hand must be visible to `enable` without the
  // model first remembering a separate reload step.
  deps.registry.discover();
  switch (args.action) {
    case "create": {
      // `action` and `note` come out first — `note` belongs to `trust`, and a
      // `create` that carried one would otherwise be rejected as an
      // unrecognized key by the strict re-parse below.
      const parsed = CreateExtensionArgsSchema.safeParse(operationArgs(args, ["action", "note"]));
      if (!parsed.success) {
        return { ok: false, action: args.action, error: `create requires the full extension definition: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
      }
      return handleCreateExtension(parsed.data, deps);
    }
    case "list":
      return handleListExtensions(deps);
    case "validate":
      return handleValidateExtension(requireId(args, "validate"), deps);
    case "enable":
      return handleEnableExtension(requireId(args, "enable"), deps);
    case "trust":
      return handleTrustExtension({ id: requireId(args, "trust").id, ...(args.note !== undefined ? { note: args.note } : {}) }, deps);
    case "uninstall":
      return handleUninstallExtension(requireId(args, "uninstall"), deps);
  }
}

function requireId(args: ExtensionManagerArgs, action: string): ValidateExtensionArgs & EnableExtensionArgs & UninstallExtensionArgs {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) throw new Error(`extension_manager action="${action}" requires "id"`);
  return { id };
}