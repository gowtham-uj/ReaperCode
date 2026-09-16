/**
 * Lifecycle — install / uninstall / draft / test / trust for skills.
 *
 * Install paths:
 *   - `installFromPath(srcPath, scope)` — copy a folder from anywhere
 *     into the user or project skills dir. Used by `skill add`.
 *   - `createDraft(manifest, body)` — author a new skill. The skill
 *     starts as `trust: "draft"`. Used by `skill create`.
 *   - `approveDraft(name)` — promote a draft to user-trusted. Requires
 *     `testSkill(name)` to have passed. Used by `skill trust` on a
 *     draft.
 *   - `testSkill(name)` — run `manifest.validation.commands` in order.
 *     Used by `skill test`.
 *   - `uninstall(name, scope)` — remove a skill folder. Used by
 *     `skill delete` and `skill untrust`.
 *
 * All lifecycle methods are responsible for:
 *   1. Updating the SkillRegistry in memory.
 *   2. Updating the TrustResolver's trust.json cache.
 *   3. Persisting the SkillMemoryRegistry entry for the legacy CLI.
 *
 * The `runCommand` callback is the only thing this module uses to actually run
 * shell, and its default is sandboxed. That was not always true: the default ran
 * `spawnSync(cmd, { shell: true, cwd })` unconfined, so a validation command from
 * a manifest read the whole filesystem while `bash` and `eval` in the same
 * session saw only the workspace. The default now goes through
 * `buildSandboxedShellCommand`, the same builder `bash` uses, so the boundary
 * holds whichever caller constructs the lifecycle rather than only for the ones
 * that remembered to pass their own runner. A caller may still supply
 * `runCommand`, and the CLI does, but omitting it is no longer the unsafe choice.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as pathResolve, sep } from "node:path";

import type { SkillMemoryRegistry } from "../adaptive/skill-memory-registry.js";
import { parseSkillManifest, sha256OfManifest, writeSkillManifest } from "./manifest.js";
import { SkillRegistry } from "./registry.js";
import { TrustResolver } from "./trust.js";
import { buildSandboxedShellCommand } from "../policy/shell-sandbox.js";
import { buildChildEnv } from "../tools/child-env.js";
import {
  type InstalledSkillRecord,
  type SkillManifest,
  type SkillTrust,
  SkillValidationError,
} from "./types.js";

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommandFn = (cmd: string, cwd?: string) => Promise<RunCommandResult> | RunCommandResult;

export interface LifecycleOptions {
  registry: SkillRegistry;
  memory: SkillMemoryRegistry;
  resolver: TrustResolver;
  workspaceRoot: string;
  userHome: string;
  builtinRoot: string;
  runCommand?: RunCommandFn;
}

export interface InstallFromPathInput {
  srcPath: string;
  scope: "user" | "project";
  trust?: boolean;
}

export interface InstallResult {
  ok: boolean;
  name: string;
  skillDir: string;
  trust: SkillTrust;
  error?: string;
}

/**
 * Run a validation command, confined to the workspace.
 *
 * A validation command is a shell line the *manifest* supplies, which is not the
 * same trust level as a line the user typed. It used to run as
 * `spawnSync(cmd, { shell: true, cwd })` with no cwd default and no sandbox, so
 * a skill whose command was `ls /work` read the Reaper installation tree while
 * `bash` and `eval` in the same session could not see it at all. A validation
 * command is code from a file, and the file can come from anywhere.
 *
 * So it runs the way every other untrusted command runs: bubblewrap, with the
 * workspace mounted and nothing else. `buildSandboxedShellCommand` is the same
 * builder `bash` uses, so there is one sandbox and not a second one to keep in
 * step. A manifest-supplied `cwd` is honoured only when it resolves inside the
 * workspace, because a working directory elsewhere is not something this feature
 * has any business using.
 *
 * When bubblewrap is unavailable the command still runs, in the workspace
 * directory rather than in the process's own. That is weaker, and it is the same
 * fallback every sandboxed path in this codebase takes: refusing to validate a
 * skill at all on a host without bubblewrap would break the feature to enforce a
 * boundary the rest of the system is not enforcing either.
 */
function defaultRunCommand(workspaceRoot: string): RunCommandFn {
  return (cmd, cwd) => {
    const root = pathResolve(workspaceRoot);
    const requested = cwd === undefined ? root : pathResolve(root, cwd);
    const workingDirectory = requested === root || requested.startsWith(root + sep) ? requested : root;

    const sandboxed = buildSandboxedShellCommand({
      workspaceRoot: root,
      workingDirectory,
      shell: "/bin/sh",
      shellArgs: ["-c", cmd],
    });

    try {
      /*
       * A scrubbed environment, for the same reason as the extension path: an
       * inherited `process.env` put the provider token inside a command that
       * only had to print it.
       */
      const env = buildChildEnv({ workspaceRoot: root }).env;
      const r = sandboxed
        ? spawnSync(sandboxed.command, sandboxed.args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env })
        : spawnSync("/bin/sh", ["-c", cmd], { cwd: workingDirectory, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, env });
      return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    } catch (e) {
      return { exitCode: 127, stdout: "", stderr: (e as Error).message };
    }
  };
}

export class SkillLifecycle {
  private readonly opts: LifecycleOptions;
  constructor(opts: LifecycleOptions) {
    this.opts = opts;
  }

  /**
   * Install a skill from an arbitrary folder into the user or
   * project skills dir. Copies the entire folder verbatim, then
   * parses the manifest and registers the record.
   */
  installFromPath(input: InstallFromPathInput): InstallResult {
    const targetRoot = input.scope === "user"
      ? join(this.opts.userHome, ".reaper", "skills")
      : join(this.opts.workspaceRoot, ".reaper", "skills");
    const manifestSrc = join(input.srcPath, "skill.json");
    if (!existsSync(manifestSrc)) {
      return { ok: false, name: "", skillDir: "", trust: "draft", error: `no skill.json at ${manifestSrc}` };
    }
    const raw = readFileSync(manifestSrc, "utf8");
    let manifest: SkillManifest;
    try {
      manifest = parseSkillManifest(raw);
    } catch (e) {
      return { ok: false, name: "", skillDir: "", trust: "draft", error: (e as Error).message };
    }
    const targetDir = join(targetRoot, manifest.name);
    if (existsSync(targetDir)) {
      return { ok: false, name: manifest.name, skillDir: targetDir, trust: "draft", error: `skill already exists at ${targetDir}` };
    }
    mkdirSync(targetRoot, { recursive: true });
    cpSync(input.srcPath, targetDir, { recursive: true });
    const decision = this.opts.resolver.resolve({ skillPath: targetDir, declaredTrust: input.trust ? "user-trusted" : "project-untrusted" });
    const finalTrust: SkillTrust = input.trust ? "user-trusted" : decision.trust;
    if (input.trust) this.opts.resolver.promote(targetDir, `installed via lifecycle.installFromPath`);
    const body = readBodyFromFolder(targetDir);
    const record: InstalledSkillRecord = {
      manifest: { ...manifest, trust: finalTrust },
      body,
      sourcePath: join(targetDir, "SKILL.md"),
      skillDir: targetDir,
      trust: finalTrust,
      scope: input.scope,
      installedAt: Date.now(),
      manifestSha256: sha256OfManifest(manifest),
    };
    this.opts.registry.register(record);
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true, name: manifest.name, skillDir: targetDir, trust: finalTrust };
  }

  /**
   * Author a new skill from a manifest + body.
   *
   * It lands in the **user skills root** — `~/.reaper/skills/<name>/` — and is
   * usable the moment this returns. It is not written to a `drafts/`
   * subdirectory, and there is no approval step before it can be activated.
   *
   * That was the old shape, and it could not work. `drafts/` is not a directory
   * discovery walks, so a skill created by the model was invisible to
   * `activate_skill` by construction: `create` wrote to one place, activation
   * looked in another, and the only error the model saw was "not registered in
   * the SkillMemoryRegistry" — a statement about a registry it had never been
   * told it needed to write to. Worse, `uninstall` looked for the name in the
   * user root, so a draft could not be removed either. Create worked, and
   * everything downstream of it silently did not.
   *
   * The name is kept for callers that use it, but it now means "create", not
   * "create something that needs promoting". A skill the user asked for is a
   * skill the user wants.
   */
  createDraft(manifest: SkillManifest, body: string): InstallResult {
    if (!manifest.name) throw new SkillValidationError("name", "EREQUIRED", "name is required");
    const targetDir = join(this.opts.userHome, ".reaper", "skills", manifest.name);
    if (existsSync(targetDir)) {
      return {
        ok: false,
        name: manifest.name,
        skillDir: targetDir,
        trust: "user-trusted",
        error: `a skill named "${manifest.name}" already exists at ${targetDir}`,
      };
    }
    mkdirSync(targetDir, { recursive: true });
    const finalManifest: SkillManifest = { ...manifest, trust: "user-trusted" };
    writeSkillManifest(finalManifest, targetDir);
    writeFileSync(join(targetDir, "SKILL.md"), body);
    const record: InstalledSkillRecord = {
      manifest: finalManifest,
      body,
      sourcePath: join(targetDir, "SKILL.md"),
      skillDir: targetDir,
      trust: "user-trusted",
      scope: "user",
      installedAt: Date.now(),
      manifestSha256: sha256OfManifest(finalManifest),
    };
    this.opts.registry.register(record);
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true, name: manifest.name, skillDir: targetDir, trust: "user-trusted" };
  }

  /**
   * Promote a draft to user-trusted. The draft moves out of
   * `drafts/` into the user skills root, and trust.json is written.
   */
  approveDraft(name: string): InstallResult {
    const draftDir = join(this.opts.userHome, ".reaper", "skills", "drafts", name);
    if (!existsSync(draftDir)) {
      return { ok: false, name, skillDir: "", trust: "draft", error: `no draft at ${draftDir}` };
    }
    const targetDir = join(this.opts.userHome, ".reaper", "skills", name);
    if (existsSync(targetDir)) {
      return { ok: false, name, skillDir: targetDir, trust: "draft", error: `skill already exists at ${targetDir}` };
    }
    cpSync(draftDir, targetDir, { recursive: true });
    this.opts.resolver.promote(targetDir, `approved via lifecycle.approveDraft`);
    const record = this.opts.registry.get(name);
    if (record) {
      this.opts.registry.register({
        ...record,
        skillDir: targetDir,
        trust: "user-trusted",
        manifest: { ...record.manifest, trust: "user-trusted" },
        sourcePath: join(targetDir, "SKILL.md"),
      });
      this.opts.registry.syncTo(this.opts.memory);
    }
    return { ok: true, name, skillDir: targetDir, trust: "user-trusted" };
  }

  /**
   * Run validation.commands for a skill and update `lastValidatedAt`
   * on success. The runCommand callback defaults to a sync shell;
   * pass a sandboxed async runner from the CLI to enforce policy.
   */
  async testSkill(name: string): Promise<{ ok: boolean; results: Array<{ id: string; exitCode: number; stdout: string; stderr: string }>; error?: string; note?: string }> {
    const r = this.opts.registry.get(name);
    if (!r) return { ok: false, results: [], error: `skill "${name}" not found` };
    const cmds = r.manifest.validation?.commands ?? [];
    if (cmds.length === 0) {
      /*
       * Nothing to validate is a success, not a failure with a message in the
       * `error` field. Putting "no validation commands declared" in `error`
       * made a healthy skill read as broken to anything that checks `ok` or
       * looks for a non-empty `error`; the remark belongs in `note`, which is
       * what says "this is fine, there was just nothing to do".
       */
      return { ok: true, results: [], note: "no validation commands declared" };
    }
    const run = this.opts.runCommand ?? defaultRunCommand(this.opts.workspaceRoot);
    /*
     * `stdout` is carried through as well as `stderr`. A validation command
     * usually reports through stdout — a test summary, a printed marker — and
     * keeping only stderr meant a command that exited 0 with a result was
     * returned as `{ id, exitCode: 0, stderr: "" }` and its output vanished.
     */
    const results: Array<{ id: string; exitCode: number; stdout: string; stderr: string }> = [];
    for (const c of cmds) {
      const out = await run(c.command, c.cwd);
      results.push({ id: c.id, exitCode: out.exitCode, stdout: out.stdout ?? "", stderr: out.stderr });
      if (out.exitCode !== 0) {
        return { ok: false, results, error: `validation command "${c.id}" failed with exit ${out.exitCode}` };
      }
    }
    const validated: InstalledSkillRecord = { ...r, lastValidatedAt: Date.now() };
    this.opts.registry.register(validated);
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true, results };
  }

  /**
   * Remove a skill from the registry and (best effort) from disk.
   * The legacy SkillMemoryRegistry is updated so `skill list` and
   * `skill show` no longer surface it.
   */
  uninstall(name: string, scope: "user" | "project" | "builtin"): { ok: boolean; error?: string } {
    const r = this.opts.registry.get(name);
    if (!r) return { ok: false, error: `skill "${name}" not found` };
    this.opts.registry.unregister(name);
    this.opts.memory.forget(name);
    /*
     * The folder is found, not computed from the caller's scope.
     *
     * `createDraft` writes every skill to the user root regardless of the
     * manifest's own `scope`, and this used the *caller's* scope to build the
     * path. So creating with `scope: "project"` and uninstalling with
     * `scope: "project"` looked in the project directory, found nothing, and
     * returned `ok: true` while the skill sat in the user directory: still on
     * disk, dropped from the in-memory registry, and therefore invisible to
     * `skill_manager list` while `activate_skill` went on serving it. Removal
     * that reports success and does not remove is worse than a refusal, because
     * the model has no signal to retry.
     *
     * The registry record knows where the skill actually is, so that is what is
     * used. The caller's scope is a hint about intent, not a fact about the
     * filesystem, and the two disagreeing is exactly the bug.
     */
    const candidates = [
      // Where the record says it lives, when it says.
      ...(r.sourcePath ? [r.sourcePath] : []),
      join(this.opts.userHome, ".reaper", "skills", name),
      join(this.opts.workspaceRoot, ".reaper", "skills", name),
      join(this.opts.builtinRoot, name),
    ];
    /*
     * Every candidate is removed rather than the first that exists, because a
     * skill can legitimately be in more than one place: a user copy shadowing a
     * project one is the same name in two roots, and leaving the shadow behind
     * means the next session re-discovers it.
     */
    let removeError: string | undefined;
    let removedAny = false;
    for (const target of candidates) {
      if (!existsSync(target)) continue;
      try {
        rmSync(target, { recursive: true, force: true });
        removedAny = true;
      } catch (e) {
        removeError = (e as Error).message;
      }
    }
    /*
     * `ok: false` when nothing was removed and the message says so, rather than
     * the old silent success. `scope` is still reported so a caller can tell a
     * genuine "already gone" from a path that was never right.
     */
    if (!removedAny) {
      return { ok: false, error: `skill "${name}" was removed from the registry but not found on disk under any known root (${scope})` };
    }
    if (removeError !== undefined) {
      return { ok: true, error: `removed from registry but not entirely from disk: ${removeError}` };
    }
    // Also clean up draft
    const draft = join(this.opts.userHome, ".reaper", "skills", "drafts", name);
    if (existsSync(draft)) {
      try { rmSync(draft, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    return { ok: true };
  }

  /**
   * Promote a project-untrusted skill to user-trusted. The CLI's
   * `skill trust <name>` calls through here.
   */
  trust(name: string, note?: string): { ok: boolean; error?: string } {
    const r = this.opts.registry.get(name);
    if (!r) return { ok: false, error: `skill "${name}" not found` };
    if (r.trust === "draft") {
      return { ok: false, error: `cannot trust a draft; run "skill test ${name}" then "skill trust ${name}" (drafts have a separate approve flow)` };
    }
    const record = this.opts.resolver.promote(r.skillDir, note);
    this.opts.registry.register({ ...r, trust: "user-trusted", manifest: { ...r.manifest, trust: "user-trusted" } });
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true };
  }

  /**
   * Demote a previously trusted skill back to project-untrusted.
   */
  untrust(name: string, note?: string): { ok: boolean; error?: string } {
    const r = this.opts.registry.get(name);
    if (!r) return { ok: false, error: `skill "${name}" not found` };
    this.opts.resolver.demote(r.skillDir, note);
    this.opts.registry.register({ ...r, trust: "project-untrusted", manifest: { ...r.manifest, trust: "project-untrusted" } });
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true };
  }
}

function readBodyFromFolder(folder: string): string {
  const path = join(folder, "SKILL.md");
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

/** Convenience for the CLI: produce a one-line "summary" of a record. */
export function recordSummary(r: InstalledSkillRecord): string {
  const flags = r.lastValidatedAt ? " [validated]" : "";
  return `${r.trust}\t${r.manifest.name}\t${r.manifest.category}\t${r.manifest.description}${flags}`;
}
