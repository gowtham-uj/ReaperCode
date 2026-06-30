/**
 * ExtensionRegistry — the install / activation / lookup surface for
 * extensions. Walks the 3 install locations (built-in / user /
 * project), parses manifests, runs activation in fault-isolated
 * context, and exposes the merged tool registry + skill records.
 *
 * Activation flow:
 *   1. `discover({workspaceRoot, userHome})` walks the 3 dirs and
 *      parses manifests. No imports yet.
 *   2. `install(srcPath, scope)` copies an extension into the right
 *      install dir, runs package.ts checks, and registers trust.
 *   3. `activateAll()` imports each enabled+trusted extension's
 *      `main` (via dynamic import, fault-isolated), invokes
 *      `default.activate(ctx)` inside the HookRunner envelope, and
 *      records the LoadedExtension.status.
 *   4. `deactivateAll()` calls `deactivate(ctx)` in reverse order.
 *
 * Failure handling: any thrown error in activate() becomes
 * `{status: "failed", error}` on the LoadedExtension. The host
 * (CLI or TUI) never sees the exception. The HookRunner envelope
 * adds timeouts and per-handler fault isolation.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { assertActivated, loadExtensionMain, type ActivatedModule } from "./loader.js";
import { ExtensionTrustResolver } from "./trust.js";
import { ExtensionToolRegistry } from "./tool-registry.js";
import { ExtensionPermissionManager } from "./permission-manager.js";
import { HookRunner } from "./hook-runner.js";
import { parseExtensionManifest } from "./manifest.js";
import { createExtensionContext, type ExtensionLoggerSink } from "./host.js";
import type {
  ExtensionDoctorReport,
  ExtensionManifest,
  ExtensionStatus,
  ExtensionTrust,
  LoadedExtension,
} from "./types.js";
import type {
  ContextProviderContribution,
  DiffRendererContribution,
  ExtensionHookRegistration,
  ExtensionPanelRegistration,
  ExtensionSkillRegistration,
  ExtensionSlashCommandRegistration,
  ExtensionToolRegistration,
  ModelProviderContribution,
  RepoAnalyzerContribution,
  TestRunnerContribution,
} from "./contribution-types.js";

export interface ExtensionRegistryOptions {
  workspaceRoot: string;
  userHome: string;
  builtinRoot: string;
  toolRegistry?: ExtensionToolRegistry;
  permissionManager?: ExtensionPermissionManager;
  hookRunner?: HookRunner;
  logSink?: ExtensionLoggerSink;
}

export interface InstallFromPathInput {
  srcPath: string;
  scope: "user" | "project";
  trust?: boolean;
}

export interface DiscoverInput {
  workspaceRoot: string;
  userHome: string;
}

export class ExtensionRegistry {
  private readonly opts: ExtensionRegistryOptions;
  /** id → LoadedExtension (manifest + install path + status). */
  private readonly loaded = new Map<string, LoadedExtension>();
  private readonly trust: ExtensionTrustResolver;
  private readonly toolRegistry: ExtensionToolRegistry;
  private readonly permissions: ExtensionPermissionManager;
  private readonly hookRunner: HookRunner | null;

  constructor(opts: ExtensionRegistryOptions) {
    this.opts = opts;
    this.trust = new ExtensionTrustResolver({
      builtinRoot: opts.builtinRoot,
      userHomeExtensionsDir: join(opts.userHome, ".reaper", "extensions"),
      projectExtensionsDir: join(opts.workspaceRoot, ".reaper", "extensions"),
    });
    this.toolRegistry = opts.toolRegistry ?? new ExtensionToolRegistry();
    this.permissions = opts.permissionManager ?? this.toolRegistry.getPermissions();
    this.hookRunner = opts.hookRunner ?? null;
  }

  /** Walk the 3 install locations and parse manifests. */
  discover(_input?: DiscoverInput): LoadedExtension[] {
    const out: LoadedExtension[] = [];
    for (const folder of [this.opts.builtinRoot, join(this.opts.userHome, ".reaper", "extensions"), join(this.opts.workspaceRoot, ".reaper", "extensions")]) {
      for (const ent of enumerateFolders(folder)) {
        const loaded = this.loadManifestFromDir(ent);
        if (loaded) out.push(loaded);
      }
    }
    // Dedup by id; later wins.
    const dedup = new Map<string, LoadedExtension>();
    for (const l of out) dedup.set(l.id, l);
    this.loaded.clear();
    for (const l of dedup.values()) this.loaded.set(l.id, l);
    return [...dedup.values()];
  }

  /** Get a LoadedExtension by id. */
  get(id: string): LoadedExtension | null {
    return this.loaded.get(id) ?? null;
  }

  /** List all loaded extensions. */
  list(): LoadedExtension[] {
    return [...this.loaded.values()];
  }

  /**
   * Install an extension from a source folder into the user or
   * project extensions dir. Copies the source verbatim, writes
   * trust.json, and records the LoadedExtension.
   */
  install(input: InstallFromPathInput): { ok: boolean; id?: string; error?: string } {
    const manifestSrc = join(input.srcPath, "extension.json");
    if (!existsSync(manifestSrc)) {
      return { ok: false, error: `no extension.json at ${manifestSrc}` };
    }
    let manifest: ExtensionManifest;
    try {
      manifest = parseExtensionManifest(readFileSync(manifestSrc, "utf8"));
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const targetRoot = input.scope === "user"
      ? join(this.opts.userHome, ".reaper", "extensions")
      : join(this.opts.workspaceRoot, ".reaper", "extensions");
    const targetDir = join(targetRoot, manifest.id);
    if (existsSync(targetDir)) {
      return { ok: false, error: `extension already installed at ${targetDir}` };
    }
    mkdirSync(targetRoot, { recursive: true });
    cpSync(input.srcPath, targetDir, { recursive: true });
    const decision = this.trust.resolve({ extensionId: manifest.id, installPath: targetDir, ...(input.trust ? { declaredTrust: "user-trusted" as ExtensionTrust } : {}) });
    if (input.trust) this.trust.promote(manifest.id, targetDir, `installed via ExtensionRegistry.install`);
    const trustFinal: ExtensionTrust = input.trust ? "user-trusted" : decision.trust;
    const record: LoadedExtension = {
      id: manifest.id,
      manifest,
      trust: trustFinal,
      status: "installed",
      installPath: targetDir,
      loadedAt: Date.now(),
    };
    this.loaded.set(manifest.id, record);
    return { ok: true, id: manifest.id };
  }

  uninstall(id: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    this.loaded.delete(id);
    this.toolRegistry.unregisterAllForExtension(id);
    if (existsSync(r.installPath)) {
      try { rmSync(r.installPath, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: true };
  }

  enable(id: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    r.status = "enabled";
    return { ok: true };
  }

  disable(id: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    r.status = "disabled";
    this.toolRegistry.unregisterAllForExtension(id);
    return { ok: true };
  }

  trust_(id: string, note?: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    this.trust.promote(id, r.installPath, note);
    r.trust = "user-trusted";
    return { ok: true };
  }

  untrust(id: string, note?: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    this.trust.demote(id, r.installPath, note);
    r.trust = "project-untrusted";
    return { ok: true };
  }

  /**
   * Run doctor on a single extension (or all of them). Returns
   * the report; failures land in `errors[]`.
   */
  doctor(id?: string): ExtensionDoctorReport[] {
    const targets = id ? [this.loaded.get(id)].filter(Boolean) as LoadedExtension[] : [...this.loaded.values()];
    return targets.map((r) => this.doctorOne(r));
  }

  /**
   * Activate every enabled + trusted extension. Returns the count
   * of successfully activated extensions. Failures are recorded
   * on the LoadedExtension.status but do not throw.
   */
  async activateAll(): Promise<{ activated: number; failed: number }> {
    let activated = 0;
    let failed = 0;
    for (const r of this.loaded.values()) {
      if (r.status !== "enabled" && r.status !== "installed") continue;
      if (r.trust === "project-untrusted") {
        // Project-untrusted extensions stay dormant until `extensions trust`.
        r.status = "disabled";
        continue;
      }
      const ok = await this.activateOne(r);
      if (ok) activated++;
      else failed++;
    }
    return { activated, failed };
  }

  /**
   * Activate one extension. Returns true on success, false on
   * failure. The failure is recorded on r.error + r.status.
   */
  async activateOne(r: LoadedExtension): Promise<boolean> {
    const loadResult = await loadExtensionMain(r.installPath, r.manifest);
    if (!loadResult.ok || !loadResult.module) {
      r.status = "failed";
      r.error = loadResult.error ?? "load failed";
      return false;
    }
    let activated: ActivatedModule["default"];
    try {
      activated = assertActivated(loadResult.module);
    } catch (e) {
      r.status = "failed";
      r.error = e instanceof Error ? e.message : String(e);
      return false;
    }
    const ctx = createExtensionContext({
      extensionId: r.id,
      trust: r.trust,
      workspaceRoot: this.opts.workspaceRoot,
      scratchpadPath: join(this.opts.workspaceRoot, ".reaper", "scratch"),
      extensionInstallPath: r.installPath,
      ...(this.opts.logSink ? { logSink: this.opts.logSink } : {}),
      onRegisterTool: (reg) => this.onRegisterTool(r, reg),
      onRegisterSkill: (reg) => this.onRegisterSkill(r, reg),
      onRegisterSlashCommand: (reg) => this.onRegisterSlashCommand(r, reg),
      onRegisterHook: (reg) => this.onRegisterHook(r, reg),
      onRegisterPanel: (reg) => this.onRegisterPanel(r, reg),
      onRegisterContextProvider: (p) => this.onRegisterContextProvider(r, p),
      onRegisterModelProvider: (p) => this.onRegisterModelProvider(r, p),
      onRegisterRepoAnalyzer: (a) => this.onRegisterRepoAnalyzer(r, a),
      onRegisterTestRunner: (tr) => this.onRegisterTestRunner(r, tr),
      onRegisterDiffRenderer: (d) => this.onRegisterDiffRenderer(r, d),
      permissionResolver: (p) => this.permissions.check(r.id, p),
      hasPermission: (p) => this.permissions.check(r.id, p),
    });
    // Wrap activate in the HookRunner envelope if available.
    const runner = this.hookRunner;
    const run = async () => {
      if (typeof activated.activate === "function") {
        await activated.activate(ctx as unknown);
      }
    };
    try {
      if (runner) {
        const result = await runner.runWithExtension(r.id, run);
        if (!result.ok) {
          r.status = "failed";
          if (result.error) r.error = result.error;
          return false;
        }
      } else {
        await run();
      }
      r.status = "enabled";
      delete r.error;
      return true;
    } catch (e) {
      r.status = "failed";
      r.error = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** Get the tool registry (read-only for callers). */
  getToolRegistry(): ExtensionToolRegistry {
    return this.toolRegistry;
  }

  /** Get the permission manager. */
  getPermissions(): ExtensionPermissionManager {
    return this.permissions;
  }

  /** Deactivate every enabled extension (reverse order). */
  async deactivateAll(): Promise<void> {
    const ordered = [...this.loaded.values()].reverse();
    for (const r of ordered) {
      if (r.status !== "enabled") continue;
      const loadResult = await loadExtensionMain(r.installPath, r.manifest);
      if (!loadResult.ok || !loadResult.module) continue;
      const activated = loadResult.module.default;
      if (typeof activated.deactivate !== "function") continue;
      try {
        await activated.deactivate(createExtensionContext({
          extensionId: r.id,
          trust: r.trust,
          workspaceRoot: this.opts.workspaceRoot,
          scratchpadPath: join(this.opts.workspaceRoot, ".reaper", "scratch"),
          extensionInstallPath: r.installPath,
          ...(this.opts.logSink ? { logSink: this.opts.logSink } : {}),
        }));
      } catch { /* swallow */ }
      r.status = "disabled";
    }
  }

  /* ----- registration sinks (called by the host context) ----- */

  private onRegisterTool(r: LoadedExtension, reg: ExtensionToolRegistration): void {
    const result = this.toolRegistry.register({
      extensionId: r.id,
      definition: { name: reg.name, description: reg.description, ...(reg.schema ? { schema: reg.schema } : {}) },
      metadata: reg.metadata,
      handler: reg.handler,
      grantedPermissions: r.manifest.permissions,
    });
    if (!result.ok) {
      // Surfaced via the extension's error log, not as a fatal.
      this.opts.logSink?.error(`[extension:${r.id}] registerTool failed: ${result.error}`);
    }
  }

  private onRegisterSkill(r: LoadedExtension, reg: ExtensionSkillRegistration): void {
    // Skill contribution from an extension is forwarded to the
    // skill discovery path on the next pass. For now, record the
    // extension's contributed skill on the extension record.
    (r as LoadedExtension & { contributedSkills?: ExtensionSkillRegistration[] }).contributedSkills = [
      ...((r as LoadedExtension & { contributedSkills?: ExtensionSkillRegistration[] }).contributedSkills ?? []),
      reg,
    ];
  }

  private onRegisterSlashCommand(r: LoadedExtension, reg: ExtensionSlashCommandRegistration): void {
    (r as LoadedExtension & { contributedCommands?: ExtensionSlashCommandRegistration[] }).contributedCommands = [
      ...((r as LoadedExtension & { contributedCommands?: ExtensionSlashCommandRegistration[] }).contributedCommands ?? []),
      reg,
    ];
  }

  private onRegisterHook(r: LoadedExtension, reg: ExtensionHookRegistration): void {
    if (this.hookRunner) {
      const handler = reg.handler as unknown as (env: { event: string; payload: Record<string, unknown>; blockable: boolean }) => { allow: boolean; message?: string; reason?: string } | Promise<{ allow: boolean; message?: string; reason?: string }>;
      this.hookRunner.register(r.id, reg.event, handler, { ...(reg.timeoutMs !== undefined ? { timeoutMs: reg.timeoutMs } : {}) });
    }
  }

  private onRegisterPanel(_r: LoadedExtension, _reg: ExtensionPanelRegistration): void {
    // Panel contributions are TUI-side; CLI ignores them.
  }

  private onRegisterContextProvider(_r: LoadedExtension, _p: ContextProviderContribution): void {
    // Context providers are consumed by future TUI runs; the CLI
    // ignores them. The registry just records the fact.
  }

  private onRegisterModelProvider(_r: LoadedExtension, _p: ModelProviderContribution): void {
    // Model providers are recorded; the runtime decides whether
    // to surface them via search_tools.
  }

  private onRegisterRepoAnalyzer(_r: LoadedExtension, _a: RepoAnalyzerContribution): void {
    // Repo analyzers are recorded; the runtime decides when to call.
  }

  private onRegisterTestRunner(_r: LoadedExtension, _tr: TestRunnerContribution): void {
    // Test runners are recorded; the runtime decides when to call.
  }

  private onRegisterDiffRenderer(_r: LoadedExtension, _d: DiffRendererContribution): void {
    // Diff renderers are recorded; the runtime decides when to call.
  }

  /* ----- internals ----- */

  private loadManifestFromDir(dir: string): LoadedExtension | null {
    const manifestPath = join(dir, "extension.json");
    if (!existsSync(manifestPath)) return null;
    let manifest: ExtensionManifest;
    try {
      manifest = parseExtensionManifest(readFileSync(manifestPath, "utf8"));
    } catch {
      return null;
    }
    const decision = this.trust.resolve({ extensionId: manifest.id, installPath: dir });
    const status: ExtensionStatus = decision.trust === "project-untrusted" ? "disabled" : "installed";
    return {
      id: manifest.id,
      manifest,
      trust: decision.trust,
      status,
      installPath: dir,
      loadedAt: Date.now(),
    };
  }

  private doctorOne(r: LoadedExtension): ExtensionDoctorReport {
    const errors: string[] = [];
    let manifestOk = false;
    let mainLoads = false;
    let toolsHaveMetadata = true;
    let hookTimeoutsOk = true;
    let contributionsValid = true;
    try {
      // Already parsed (discover/install did this).
      manifestOk = !!r.manifest && typeof r.manifest.id === "string";
      if (!manifestOk) errors.push("manifest invalid");
    } catch (e) {
      errors.push(`manifest error: ${(e as Error).message}`);
    }
    // Static main-resolve check
    if (!r.manifest.main) {
      errors.push("manifest.main missing");
    } else {
      const mainPath = join(r.installPath, r.manifest.main);
      try {
        // JS-only: main must resolve to a real .js file.
        mainLoads = existsSync(mainPath) || existsSync(`${mainPath}.js`) || existsSync(join(mainPath, "index.js"));
        if (!mainLoads) errors.push(`manifest.main does not resolve to a .js file at ${mainPath}`);
      } catch (e) {
        errors.push(`main resolve error: ${(e as Error).message}`);
      }
    }
    // Tool metadata check
    if (r.manifest.contributes?.tools) {
      for (const t of r.manifest.contributes.tools) {
        if (!this.toolRegistry.getMetadata(t.name)) {
          toolsHaveMetadata = false;
          errors.push(`tool "${t.name}" is registered without ToolMetadata`);
        }
      }
    }
    // Hook timeout check
    if (r.manifest.contributes?.hooks) {
      for (const h of r.manifest.contributes.hooks) {
        if (h.timeoutMs !== undefined && (h.timeoutMs <= 0 || !Number.isFinite(h.timeoutMs))) {
          hookTimeoutsOk = false;
          errors.push(`hook "${h.event}" has invalid timeout ${h.timeoutMs}ms`);
        }
      }
    }
    // Contribution shape check
    if (!r.manifest.contributes || Object.keys(r.manifest.contributes).length === 0) {
      contributionsValid = false;
      errors.push("no contributions declared");
    }
    return {
      id: r.id,
      manifestOk,
      mainLoads,
      toolsHaveMetadata,
      hookTimeoutsOk,
      contributionsValid,
      errors,
    };
  }
}

function enumerateFolders(root: string): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    if (ent.startsWith(".")) continue;
    const full = join(root, ent);
    try {
      const st = statSync(full);
      if (st.isDirectory() && !full.endsWith(".disabled")) out.push(full);
    } catch { /* ignore */ }
  }
  return out;
}

/** Helper used by tests + CLI to ensure extension paths are absolute. */
export function ensureAbsolute(p: string): string {
  if (!isAbsolute(p)) throw new Error(`extension path must be absolute (got ${p})`);
  return p;
}

/**
 * Write a trust decision to disk. Mirrors TrustResolver.persist but
 * exposed here for callers that only have an ExtensionRegistry.
 */
export function writeTrustRecord(installPath: string, record: { extensionId: string; installPath: string; trust: ExtensionTrust; decidedAt: number }): void {
  mkdirSync(installPath, { recursive: true });
  writeFileSync(join(installPath, "trust.json"), JSON.stringify(record, null, 2));
}
