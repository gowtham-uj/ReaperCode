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
      if (existsSync(path)) {
        try {
          const raw = readFileSync(path, "utf8");
          const parsed = JSON.parse(raw) as SkillIndex;
          if (parsed.version === INDEX_VERSION) return parsed;
        } catch { /* ignore */ }
      }
    }
    return { version: INDEX_VERSION, skills: {}, health: {}, usage: [], updatedAt: new Date().toISOString() };
  }

  private save(scope: SkillScope): void {
    const path = scope === "user" ? this.userIndexPath : this.projectIndexPath;
    mkdirSync(join(path, ".."), { recursive: true });
    this.index.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(this.index, null, 2));
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

  /** Remove a skill from the registry. */
  forget(name: string): boolean {
    const skill = this.index.skills[name];
    if (!skill) return false;
    delete this.index.skills[name];
    delete this.index.health[name];
    this.save(skill.scope);
    return true;
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
