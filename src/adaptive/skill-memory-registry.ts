/**
 * SkillMemoryRegistry — tracks skill usage, health, and links skills
 * to memories and run traces.
 *
 * Storage:
 *  - project: <workspace>/.reaper/skills/index.json
 *  - user:    ~/.reaper/skills/index.json
 *
 * The index is JSON-serializable and human-readable. The runtime
 * re-reads the index at boot; mutations are persisted to disk on
 * every change.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ReaperSkill, SkillHealth, SkillScope, SkillUsageMode, SkillUsageRecord, SkillOutcome } from "./types.js";

const INDEX_VERSION = 1;

export interface SkillIndex {
  version: number;
  skills: Record<string, ReaperSkill>;
  health: Record<string, SkillHealth>;
  usage: SkillUsageRecord[];
  updatedAt: string;
}

export interface SkillMemoryRegistryOptions {
  workspaceRoot: string;
  userHome?: string;
}

export class SkillMemoryRegistry {
  private projectIndexPath: string;
  private userIndexPath: string;
  private index: SkillIndex;
  private readonly maxUsageHistory: number;

  constructor(opts: SkillMemoryRegistryOptions) {
    this.projectIndexPath = join(opts.workspaceRoot, ".reaper", "skills", "index.json");
    this.userIndexPath = join(opts.userHome ?? process.env.HOME ?? "~", ".reaper", "skills", "index.json");
    this.maxUsageHistory = 500;
    this.index = this.load();
  }

  private load(): SkillIndex {
    for (const path of [this.projectIndexPath, this.userIndexPath]) {
      const parsed = this.readIndexFile(path);
      if (parsed) return parsed;
    }
    return { version: INDEX_VERSION, skills: {}, health: {}, usage: [], updatedAt: new Date().toISOString() };
  }

  /** Read one index file, or null when it is missing, malformed, or a version we do not understand. */
  private readIndexFile(path: string): SkillIndex | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SkillIndex;
      return parsed.version === INDEX_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeIndexFile(path: string, index: SkillIndex): void {
    mkdirSync(join(path, ".."), { recursive: true });
    index.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(index, null, 2));
  }

  private save(scope: SkillScope): void {
    this.writeIndexFile(scope === "user" ? this.userIndexPath : this.projectIndexPath, this.index);
  }

  /** Add or update a skill. */
  upsertSkill(skill: ReaperSkill): void {
    this.index.skills[skill.name] = skill;
    if (!this.index.health[skill.name]) {
      this.index.health[skill.name] = { skillName: skill.name, successCount: 0, failureCount: 0, confidence: 0.5 };
    }
    this.save(skill.scope);
  }

  /**
   * F1: drop any in-memory cache and reload from disk. Intended
   * for tests that mutate the index file directly between runs.
   */
  clearCache(): void {
    this.index = this.load();
  }

  getSkill(name: string): ReaperSkill | null {
    return this.index.skills[name] ?? null;
  }

  listSkills(scope?: SkillScope): ReaperSkill[] {
    const all = Object.values(this.index.skills);
    return scope ? all.filter((s) => s.scope === scope) : all;
  }

  /** Record a usage event and update skill health. */
  recordUsage(input: {
    skillName: string;
    runId: string;
    taskId?: string;
    invocationMode: SkillUsageMode;
    outcome: SkillOutcome;
    evidence: string[];
    validationCommandsRun: string[];
  }): void {
    const skill = this.index.skills[input.skillName];
    if (!skill) return;
    const usage: SkillUsageRecord = {
      skillName: input.skillName,
      scope: skill.scope,
      runId: input.runId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      invokedAt: new Date().toISOString(),
      invocationMode: input.invocationMode,
      outcome: input.outcome,
      evidence: input.evidence,
      validationCommandsRun: input.validationCommandsRun,
    };
    this.index.usage.push(usage);
    if (this.index.usage.length > this.maxUsageHistory) {
      this.index.usage = this.index.usage.slice(-this.maxUsageHistory);
    }
    const h = this.index.health[input.skillName] ?? { skillName: input.skillName, successCount: 0, failureCount: 0, confidence: 0.5 };
    if (input.outcome === "success") {
      h.successCount++;
      h.lastUsedAt = usage.invokedAt;
    } else if (input.outcome === "failed") {
      h.failureCount++;
    }
    const total = h.successCount + h.failureCount;
    h.confidence = total === 0 ? 0.5 : h.successCount / total;
    if (h.failureCount >= 3 && h.failureCount > h.successCount) {
      h.disabledReason = "repeated failures";
    }
    this.index.health[input.skillName] = h;
    this.save(skill.scope);
  }

  /** Mark a skill as validated. */
  markValidated(name: string): void {
    const h = this.index.health[name];
    if (!h) return;
    h.lastValidatedAt = new Date().toISOString();
    if (h.confidence < 0.6) h.confidence = 0.6;
    const skill = this.index.skills[name];
    if (skill) this.save(skill.scope);
  }

  /** Disable a skill with a reason. */
  disable(name: string, reason: string): boolean {
    const skill = this.index.skills[name];
    if (!skill) return false;
    skill.disableAutoInvocation = true;
    const h = this.index.health[name];
    if (h) h.disabledReason = reason;
    this.save(skill.scope);
    return true;
  }

  /**
   * Remove a skill from the registry, from *every* index file that names it.
   *
   * The old version looked the skill up in `this.index` — the single index
   * `load()` returned, which is the first one that exists (project before user)
   * — deleted it there, and saved only to that scope's file. So a skill that
   * had been written to the **user** index while a **project** index also
   * existed was never actually removed: `forget` did not find it in the loaded
   * (project) index, returned false, and left the user index untouched. The
   * skill's folder was deleted by the lifecycle but its entry, including its
   * health record, stayed behind. `activate_skill` then saw a registered skill
   * whose directory was gone and failed with "registered in the registry but no
   * on-disk file was found" — an error about a skill the user had just
   * successfully uninstalled.
   *
   * Purging each file independently makes removal match what the user asked
   * for, regardless of which index a since-deleted run happened to load.
   */
  forget(name: string): boolean {
    let removed = false;
    for (const path of [this.userIndexPath, this.projectIndexPath]) {
      const index = this.readIndexFile(path);
      if (!index) continue;
      if (index.skills[name] === undefined && index.health[name] === undefined) continue;
      delete index.skills[name];
      delete index.health[name];
      this.writeIndexFile(path, index);
      removed = true;
    }
    const hadInMemory = this.index.skills[name] !== undefined || this.index.health[name] !== undefined;
    delete this.index.skills[name];
    delete this.index.health[name];
    return removed || hadInMemory;
  }

  /** Get a skill's health. */
  health(name: string): SkillHealth | null {
    return this.index.health[name] ?? null;
  }

  /** Get a skill's recent usage. */
  recentUsage(name: string, n = 10): SkillUsageRecord[] {
    return this.index.usage.filter((u) => u.skillName === name).slice(-n);
  }

  /** Skills with stale validation (older than `maxAgeMs`). */
  staleSkills(maxAgeMs: number): string[] {
    const cutoff = Date.now() - maxAgeMs;
    return Object.values(this.index.health)
      .filter((h) => h.lastValidatedAt !== undefined && new Date(h.lastValidatedAt).getTime() < cutoff)
      .map((h) => h.skillName);
  }

  /** Snapshot the registry for inspection. */
  snapshot(): SkillIndex {
    return JSON.parse(JSON.stringify(this.index));
  }
}
