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
import type {
  CreateExtensionArgs,
  ValidateExtensionArgs,
  EnableExtensionArgs,
  TrustExtensionArgs,
  UninstallExtensionArgs,
  ReloadExtensionsArgs,
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

export async function handleValidateExtension(
  args: ValidateExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; results: Array<{ id: string; exitCode: number; stderr: string }>; error?: string }> {
  return deps.lifecycle.validate(args.id);
}

export async function handleEnableExtension(
  args: EnableExtensionArgs,
  deps: ExtensionToolDeps,
): Promise<{ ok: boolean; id: string; activated: boolean; error?: string }> {
  const r = deps.registry.get(args.id);
  if (!r) return { ok: false, id: args.id, activated: false, error: `extension "${args.id}" not loaded` };
  if (r.trust !== "user-trusted") {
    return { ok: false, id: args.id, activated: false, ...(true ? { error: `cannot enable untrusted extension (trust=${r.trust}); call trust_extension first` } : {}) };
  }
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

export function handleReloadExtensions(
  _args: ReloadExtensionsArgs,
  deps: ExtensionToolDeps,
): { ok: boolean; loaded: number } {
  const loaded = deps.registry.discover();
  return { ok: true, loaded: loaded.length };
}