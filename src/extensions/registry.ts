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
import { isAbsolute, join, resolve, sep } from "node:path";

import { assertActivated, loadExtensionMain, type ActivatedModule } from "./loader.js";
import { isProjectTrustedSync, ProjectTrustStore, resolveProjectTrusted } from "../resources/project-trust.js";
import { ExtensionTrustResolver } from "./trust.js";
import { ExtensionToolRegistry } from "./tool-registry.js";
import { ExtensionPermissionManager } from "./permission-manager.js";
import { HookRunner } from "./hook-runner.js";
import { parseExtensionManifest } from "./manifest.js";
import { TOOL_METADATA } from "../governance/tool-metadata.js";
import { toolRegistry } from "../tools/registry.js";
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
  /** Manifest load errors collected by discover(), exposed via getLoadErrors(). */
  private readonly loadErrors: { path: string; error: string }[] = [];

  constructor(opts: ExtensionRegistryOptions) {
    this.opts = opts;
    this.trust = new ExtensionTrustResolver({
      builtinRoot: opts.builtinRoot,
      userHomeExtensionsDir: join(opts.userHome, ".reaper", "extensions"),
      projectExtensionsDir: join(opts.workspaceRoot, ".reaper", "extensions"),
    });
    /*
     * The built-in names, so an extension cannot claim one.
     *
     * Two sources, unioned, because neither alone is the whole set. `toolRegistry`
     * is what the executor dispatches on and `TOOL_METADATA` is what the policy
     * layer knows about; `hook_manager`, `extension_manager` and `skill_manager`
     * are in the first and not the second, and an extension claiming
     * `hook_manager` was accepted while `write_file` was refused. Their
     * descriptions are what reaches the model, so the gap mattered.
     */
    const builtinToolNames = new Set([
      ...Object.keys(toolRegistry),
      ...Object.keys(TOOL_METADATA),
    ]);
    this.toolRegistry = opts.toolRegistry ?? new ExtensionToolRegistry({
      reservedToolNames: builtinToolNames,
    });
    this.permissions = opts.permissionManager ?? this.toolRegistry.getPermissions();
    this.hookRunner = opts.hookRunner ?? null;
  }

  /**
   * Walk the 3 install locations and parse manifests.
   *
   * Runtime state survives the walk. `status` and `error` are facts about this
   * *process* — whether an extension has been activated, and whether activation
   * threw — and the disk knows nothing about them. Rebuilding every record from
   * disk dropped both, so `enable` reported `activated: true`, the tool
   * registered, and the next `list` (which the manager calls before every
   * action) said `installed` as though nothing had happened. An inventory the
   * model reads to check its own work has to agree with the work.
   *
   * Trust is taken from `loadManifestFromDir`, which computes it fresh, so a
   * trust decision still comes from disk where it belongs.
   */
  discover(_input?: DiscoverInput): LoadedExtension[] {
    this.loadErrors.length = 0;
    const previous = new Map(this.loaded);
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
    for (const [id, record] of dedup) {
      const before = previous.get(id);
      if (before === undefined) {
        this.loaded.set(id, record);
        continue;
      }
      /*
       * Only the runtime fields are carried over, and only when the manifest did
       * not fail to parse. A record that failed on this walk is a real failure
       * and must not inherit a healthy status from before.
       */
      const failedNow = record.status === "failed";
      this.loaded.set(id, failedNow ? record : {
        ...record,
        ...(before.status === "enabled" || before.status === "disabled" ? { status: before.status } : {}),
        ...(before.error !== undefined ? { error: before.error } : {}),
      });
    }
    return [...this.loaded.values()];
  }

  /**
   * Refresh one extension's manifest from disk without discarding live status.
   *
   * The registry is a runtime state table, not a content cache. Keeping the
   * `loaded` map is necessary because it records whether an extension is active,
   * failed or disabled, but keeping its manifest there forever made hand-edited
   * `extension.json` stale until a separate reload action. There is no reload
   * action on the model surface now, and there should not need to be one: a read
   * of an extension reads its file.
   *
   * Trust and activation status are runtime state, not extension content, so
   * they are preserved. What is never cached is the manifest: edit
   * `extension.json` and the next `get()`/`list()` sees it. This distinction is
   * what keeps an explicitly trusted project extension trusted for the session
   * while removing the stale-content problem the user asked to remove.
   */
  private refreshRecord(record: LoadedExtension): LoadedExtension {
    const manifestPath = join(record.installPath, "extension.json");
    if (!existsSync(manifestPath)) return record;
    try {
      const manifest = parseExtensionManifest(readFileSync(manifestPath, "utf8"));
      const refreshed: LoadedExtension = {
        ...record,
        id: manifest.id,
        manifest,
      };
      if (manifest.id !== record.id) this.loaded.delete(record.id);
      this.loaded.set(manifest.id, refreshed);
      return refreshed;
    } catch (error) {
      /*
       * An invalid edit is surfaced on the existing record rather than hidden by
       * serving the last valid manifest. Serving stale content makes an invalid
       * extension look healthy, which is exactly what "no cache" is meant to
       * prevent.
       */
      return { ...record, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Get a LoadedExtension by id, with its manifest re-read from disk. */
  get(id: string): LoadedExtension | null {
    const record = this.loaded.get(id);
    return record ? this.refreshRecord(record) : null;
  }

  /** List all extensions, refreshing every manifest first. */
  list(): LoadedExtension[] {
    return [...this.loaded.values()].map((record) => this.refreshRecord(record));
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

  /**
   * Remove an extension, and stop everything it started.
   *
   * The first version deleted the folder and cleared the tool registry, and
   * both of those are only half of what an extension is. An extension also
   * registers hook handlers on the shared runner, holds permissions granted
   * from its manifest, and may have started a timer in `activate()`. None of
   * those were touched, so an uninstalled extension kept observing every tool
   * call and kept running its interval, with its directory gone and its name
   * absent from `list()`:
   *
   *   - runner handlers after uninstall: still `["evil"]`, and the hook still
   *     fired on the next `PreToolUse`, whose payload includes tool arguments;
   *   - the extension's `setInterval` kept ticking;
   *   - `deactivate` was never called, and `deactivateAll` re-imports from
   *     `installPath`, which is deleted by then, so it could never be reached.
   *
   * `async` because `deactivate` is, and calling it is the only way an
   * extension gets to clean up what it started.
   */
  async uninstall(id: string): Promise<{ ok: boolean; error?: string; partial?: boolean }> {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    /*
     * Deactivate first, while the folder still exists: `deactivate` may want to
     * write a log or flush state into its own install path, and it cannot do
     * that after the rm below.
     */
    let deactivateError: string | undefined;
    if (r.status === "enabled") {
      try {
        const loadResult = await loadExtensionMain(r.installPath, r.manifest);
        const activated = loadResult.ok ? loadResult.module?.default : undefined;
        if (activated && typeof activated.deactivate === "function") {
          await activated.deactivate(createExtensionContext({
            extensionId: r.id,
            trust: r.trust,
            workspaceRoot: this.opts.workspaceRoot,
            scratchpadPath: join(this.opts.workspaceRoot, ".reaper", "scratch"),
            extensionInstallPath: r.installPath,
            ...(this.opts.logSink ? { logSink: this.opts.logSink } : {}),
          }));
        }
      } catch (error) {
        // Reported, not fatal: the extension is being removed either way, and
        // refusing to remove it because its cleanup threw would leave it
        // installed and still running.
        deactivateError = error instanceof Error ? error.message : String(error);
      }
    }
    /*
     * Then the subscriptions, which is what actually stops it.
     *
     * `unregisterAll` returns the count so the result can say how much was
     * detached; a handler that survives its extension is the failure this whole
     * method exists to prevent.
     */
    const hooksRemoved = this.hookRunner?.unregisterAll(id) ?? 0;
    this.permissions.revokeAll(id);
    this.loaded.delete(id);
    this.toolRegistry.unregisterAllForExtension(id);
    if (existsSync(r.installPath)) {
      try {
        rmSync(r.installPath, { recursive: true, force: true });
      } catch (error) {
        // In-memory state is already cleared. Surface the on-disk failure
        // rather than pretending the uninstall succeeded — the caller
        // needs to know files remain on disk so they can retry or clean
        // up by hand.
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          partial: true,
          error: `in-memory extension removed but on-disk cleanup of ${r.installPath} failed: ${message}`,
        };
      }
    }
    return {
      ok: true,
      ...(deactivateError !== undefined
        ? { partial: true, error: `removed, but deactivate threw: ${deactivateError}` }
        : {}),
      // Reported so a caller can see the teardown happened rather than assume it.
      ...(hooksRemoved > 0 ? { hooksRemoved } : {}),
    } as { ok: boolean; error?: string; partial?: boolean };
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

  /**
   * `trust` — a semantic no-op, kept so an old caller still works.
   *
   * There are no trust tiers: an extension is trusted when it is installed, so
   * there is nothing for this to promote and nothing for `enable` to gate on.
   * The flag is set in memory for callers that read it back within the same
   * action, but it is deliberately NOT persisted for a project-scope extension:
   * `ExtensionTrustResolver.loadCached` refuses a `trust.json` under the project
   * directory, because that directory is writable by the very model the trust
   * flag would be protecting against, so a record there cannot grant trust.
   * That rule is why the real bug was never here — it was `enable` enforcing a
   * gate this method could not satisfy. See `handleEnableExtension`.
   */
  trust_(id: string, note?: string): { ok: boolean; error?: string } {
    const r = this.loaded.get(id);
    if (!r) return { ok: false, error: `extension "${id}" not loaded` };
    /*
     * Persist the decision, not only the in-memory record.
     *
     * This bug was hidden while `get()` served the map forever: trust appeared
     * to work for the rest of the process, even though no `trust.json` was
     * written. Once manifests and trust are refreshed from disk on every read,
     * the next `get()` correctly reverted to `project-untrusted`. A setting that
     * disappears when it is read is not a setting, so promote through the
     * resolver and let the file be the source of truth.
     */
    /*
     * A project extension is trusted by trusting the *workspace*.
     *
     * Writing `trust.json` beside a project extension cannot work, and the
     * resolver is right to refuse it: that file sits inside a directory anything
     * with workspace write access can edit, so honouring it would let a workspace
     * grant itself trust. Only a record under the user's own home counts.
     *
     * The extension's own `installPath` is under the workspace, so
     * `promote` wrote a file the next read discarded, and the tool reported
     * `trust: "user-trusted"` while `list` in a fresh process said
     * `project-untrusted`. The decision that *can* stick for a project extension
     * is the workspace's, which lives in the user's home and is the same record
     * the activation gate consults.
     */
    const projectScoped = this.isProjectScoped(r.installPath);
    if (projectScoped) {
      ProjectTrustStore.create(this.opts.userHome).set(this.opts.workspaceRoot, true);
    } else {
      this.trust.promote(id, r.installPath, note);
    }
    r.trust = "user-trusted";
    return { ok: true };
  }

  /** Whether an install path lives under this workspace's `.reaper/extensions`. */
  private isProjectScoped(installPath: string): boolean {
    const projectRoot = join(this.opts.workspaceRoot, ".reaper", "extensions");
    const a = installPath.endsWith(sep) ? installPath : installPath + sep;
    const b = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
    return a.startsWith(b);
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
      /*
       * No trust gate.
       *
       * This skipped any extension whose trust was `project-untrusted` and
       * silently set it to `disabled`, so an extension installed from a project
       * directory could be created, trusted and enabled and still never
       * activate — with `enable` reporting success, because enable only sets the
       * status flag this loop then overwrote. There are no trust tiers: an
       * installed extension activates when it is enabled. `enable`/`disable`
       * remain, because switching something off is a real user intent.
       */
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
    /*
     * A project-scope extension needs the project to be trusted first.
     *
     * This is Pi's rule, and it is the right one for the same reason: an
     * extension is native code with the host's privileges, and a project-scope
     * one arrives with a repository. Cloning a repo and opening it is not consent
     * to run whatever `main.js` that repo shipped, and the model can put an
     * extension there without the user ever seeing the file.
     *
     * Measured before this check: a workspace carrying
     * `.reaper/extensions/from-repo/` resolved as `{trusted:false,
     * source:"default-never"}`, and `discover()` loaded it anyway and `enable`
     * returned `{ok:true}`. Nothing consulted the trust decision, even though
     * `.reaper/extensions` is already in the trust-requiring path list and the
     * resolver had already said no.
     *
     * Only project scope. A user-scope extension lives under `~/.reaper`, which
     * nothing but the user can write, so it carries its own consent and asking
     * twice would just train the user to click through.
     */
    if (isInside(r.installPath, join(this.opts.workspaceRoot, ".reaper", "extensions"))) {
      /*
       * Read trust from this registry's own home, not the process's.
       *
       * `resolveProjectTrusted` defaults to `ProjectTrustStore.create()`, which
       * uses `homedir()`. A registry built with an explicit `userHome` (a test,
       * or a server told to read settings from elsewhere) would then consult a
       * different trust file than the one it was configured with, and a
       * workspace trusted for that home would look untrusted here. Same class
       * of bug as the credential store reading the developer's home instead of
       * the configured one: the fix is to pass the home through rather than let
       * the default win.
       */
      const trust = await resolveProjectTrusted({
        workspaceRoot: this.opts.workspaceRoot,
        store: ProjectTrustStore.create(this.opts.userHome),
      });
      if (!trust.trusted) {
        r.status = "disabled";
        r.error = `this extension is installed by the project, and the project is not trusted (${trust.source})`;
        return false;
      }
    }

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

  /** Manifest parse errors from the most recent discover() call. */
  getLoadErrors(): { path: string; error: string }[] {
    return [...this.loadErrors];
  }

  /** Deactivate every enabled extension (reverse order). */
  async deactivateAll(): Promise<{ deactivated: number; failed: number }> {
    const ordered = [...this.loaded.values()].reverse();
    let deactivated = 0;
    let failed = 0;
    for (const r of ordered) {
      if (r.status !== "enabled") continue;
      const loadResult = await loadExtensionMain(r.installPath, r.manifest);
      if (!loadResult.ok || !loadResult.module) continue;
      const activated = loadResult.module.default;
      if (typeof activated.deactivate !== "function") {
        r.status = "disabled";
        deactivated++;
        continue;
      }
      try {
        await activated.deactivate(createExtensionContext({
          extensionId: r.id,
          trust: r.trust,
          workspaceRoot: this.opts.workspaceRoot,
          scratchpadPath: join(this.opts.workspaceRoot, ".reaper", "scratch"),
          extensionInstallPath: r.installPath,
          ...(this.opts.logSink ? { logSink: this.opts.logSink } : {}),
        }));
        deactivated++;
      } catch (error) {
        failed++;
        const message = error instanceof Error ? error.message : String(error);
        r.error = `deactivate threw: ${message}`;
        if (this.opts.logSink) {
          this.opts.logSink.error(`[extension:${r.id}] deactivate threw: ${message}`);
        }
      }
      r.status = "disabled";
    }
    return { deactivated, failed };
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
    } catch (error) {
      // Capture the parse failure rather than silently dropping the
      // extension — the user wants to know that a manifest at <dir>
      // is unreadable so they can fix it.
      const message = error instanceof Error ? error.message : String(error);
      this.loadErrors.push({ path: manifestPath, error: message });
      if (this.opts.logSink) {
        this.opts.logSink.warn(`[extension] failed to parse ${manifestPath}: ${message}`);
      }
      return null;
    }
    const decision = this.trust.resolve({ extensionId: manifest.id, installPath: dir });
    /*
     * The label is the *effective* trust, not the per-extension record.
     *
     * For a project-scope extension the resolver can only ever answer
     * `project-untrusted`, because the file it would need sits inside a
     * directory the workspace can write and honouring it would let a workspace
     * grant itself trust. That answer is correct about the file and wrong about
     * the outcome: the gate that decides whether a project extension runs is the
     * *workspace's* trust, so after `extensions trust` the extension activates
     * while the label still read `project-untrusted`.
     *
     * A label that disagrees with the gate is worse than no label, because it is
     * the thing an author reads to find out why their extension is not loading.
     * So a project-scope extension reports `user-trusted` when its workspace is
     * trusted, which is exactly the condition `activateOne` checks.
     */
    const projectScoped = this.isProjectScoped(dir);
    const effectiveTrust: ExtensionTrust = projectScoped && decision.trust === "project-untrusted"
      && isProjectTrustedSync(this.opts.workspaceRoot, this.opts.userHome)
      ? "user-trusted"
      : decision.trust;
    /*
     * Installed, not disabled. An extension the user just installed is one they
     * intend to use; parking it as `disabled` until a separate trust step was
     * the other half of why enable appeared to work and did nothing.
     */
    const status: ExtensionStatus = "installed";
    return {
      id: manifest.id,
      manifest,
      trust: effectiveTrust,
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

/**
 * Whether `target` is inside `root`.
 *
 * The separator matters: a plain `startsWith` says `/ws-evil` is inside `/ws`,
 * which is the classic prefix bug, and this decides whether a directory's
 * contents are treated as the user's own or as the project's.
 */
function isInside(target: string, root: string): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + sep);
}
