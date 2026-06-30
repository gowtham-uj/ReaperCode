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
 * The `runCommand` callback is the only thing this module uses to
 * actually run shell. The default is `spawnSync` (used by tests); the
 * CLI passes in a sandboxed variant that goes through the policy
 * gate.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { SkillMemoryRegistry } from "../adaptive/skill-memory-registry.js";
import { parseSkillManifest, sha256OfManifest, writeSkillManifest } from "./manifest.js";
import { SkillRegistry } from "./registry.js";
import { TrustResolver } from "./trust.js";
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

const DEFAULT_RUN_COMMAND: RunCommandFn = (cmd, cwd) => {
  // Synchronous default. The CLI replaces this with a sandboxed
  // async runner; tests can override to avoid actually executing.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(cmd, { shell: true, cwd, encoding: "utf8" });
    return { exitCode: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { exitCode: 127, stdout: "", stderr: (e as Error).message };
  }
};

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
   * Author a new skill from a manifest + body. Lands in
   * `~/.reaper/skills/drafts/<name>/` with `trust: "draft"`. The
   * draft is NOT callable via `activate_skill` until `approveDraft`.
   */
  createDraft(manifest: SkillManifest, body: string): InstallResult {
    if (!manifest.name) throw new SkillValidationError("name", "EREQUIRED", "name is required");
    const draftRoot = join(this.opts.userHome, ".reaper", "skills", "drafts");
    const targetDir = join(draftRoot, manifest.name);
    if (existsSync(targetDir)) {
      return { ok: false, name: manifest.name, skillDir: targetDir, trust: "draft", error: `draft already exists at ${targetDir}` };
    }
    mkdirSync(targetDir, { recursive: true });
    const finalManifest: SkillManifest = { ...manifest, trust: "draft" };
    writeSkillManifest(finalManifest, targetDir);
    writeFileSync(join(targetDir, "SKILL.md"), body);
    const record: InstalledSkillRecord = {
      manifest: finalManifest,
      body,
      sourcePath: join(targetDir, "SKILL.md"),
      skillDir: targetDir,
      trust: "draft",
      scope: "user",
      installedAt: Date.now(),
      manifestSha256: sha256OfManifest(finalManifest),
    };
    this.opts.registry.register(record);
    this.opts.registry.syncTo(this.opts.memory);
    return { ok: true, name: manifest.name, skillDir: targetDir, trust: "draft" };
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
  async testSkill(name: string): Promise<{ ok: boolean; results: Array<{ id: string; exitCode: number; stderr: string }>; error?: string }> {
    const r = this.opts.registry.get(name);
    if (!r) return { ok: false, results: [], error: `skill "${name}" not found` };
    const cmds = r.manifest.validation?.commands ?? [];
    if (cmds.length === 0) return { ok: true, results: [], error: "no validation commands declared" };
    const run = this.opts.runCommand ?? DEFAULT_RUN_COMMAND;
    const results: Array<{ id: string; exitCode: number; stderr: string }> = [];
    for (const c of cmds) {
      const out = await run(c.command, c.cwd);
      results.push({ id: c.id, exitCode: out.exitCode, stderr: out.stderr });
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
    const baseDir = scope === "user"
      ? join(this.opts.userHome, ".reaper", "skills")
      : scope === "builtin"
        ? this.opts.builtinRoot
        : join(this.opts.workspaceRoot, ".reaper", "skills");
    const target = join(baseDir, name);
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch (e) {
        return { ok: true, error: `removed from registry but not from disk: ${(e as Error).message}` };
      }
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
