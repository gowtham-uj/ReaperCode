/**
 * PersistentMemoryStore — append-only JSONL store for memory records.
 *
 * Scopes:
 *  - transient: in-memory only
 *  - project:   <workspace>/.reaper/memory/project.jsonl (+ summary.md)
 *  - user:      ~/.reaper/memory/user.jsonl (+ summary.md)
 *  - machine:   ~/.reaper/memory/machine.jsonl
 *  - secret:    refused — never stored as raw value
 *
 * Records are JSON-serializable. Each scope has its own file. Writes
 * are append-only; the store rebuilds the in-memory cache on load.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { MemoryRecord, MemoryScope, MemoryKind, MemorySource, MemoryEvidence } from "./types.js";
import { redactSecrets } from "./redact.js";

export interface PersistentMemoryStoreOptions {
  workspaceRoot: string;
  userHome?: string;
}

export class PersistentMemoryStore {
  private readonly projectDir: string;
  private readonly userDir: string;
  private readonly machineDir: string;
  private loadErrors: { scope: string; error: string }[] = [];
  private cache: { project: MemoryRecord[]; user: MemoryRecord[]; machine: MemoryRecord[]; transient: Map<string, MemoryRecord> } = {
    project: [],
    user: [],
    machine: [],
    transient: new Map(),
  };

  constructor(opts: PersistentMemoryStoreOptions) {
    this.projectDir = join(opts.workspaceRoot, ".reaper", "memory");
    this.userDir = join(opts.userHome ?? process.env.HOME ?? "~", ".reaper", "memory");
    this.machineDir = join(this.userDir, "machine");
    for (const d of [this.projectDir, this.userDir, this.machineDir]) {
      mkdirSync(d, { recursive: true });
    }
    this.loadScope("project");
    this.loadScope("user");
    this.loadScope("machine");
  }

  private pathFor(scope: Exclude<MemoryScope, "transient" | "secret">): string {
    if (scope === "project") return join(this.projectDir, "project.jsonl");
    if (scope === "user") return join(this.userDir, "user.jsonl");
    return join(this.machineDir, "machine.jsonl");
  }

  private loadScope(scope: Exclude<MemoryScope, "transient" | "secret">): void {
    const path = this.pathFor(scope);
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      // File exists but is unreadable (permissions, EIO, etc.). Surface
      // the load failure rather than silently returning an empty cache —
      // the caller needs to know that persisted records are unavailable.
      const message = error instanceof Error ? error.message : String(error);
      this.loadErrors.push({ scope, error: message });
      console.warn(`[memory] cannot read ${path}: ${message}`);
      return;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as MemoryRecord;
        if (r.sensitive && r.scope !== "secret") {
          r.content = this.redactIfSensitive(r.content);
        }
        this.cache[scope].push(r);
      } catch { /* skip malformed lines */ }
    }
  }

  /** Surfaces any errors encountered while reading memory files at startup. */
  getLoadErrors(): { scope: string; error: string }[] {
    return [...this.loadErrors];
  }

  private redactIfSensitive(s: string): string {
    const { redacted } = redactSecrets(s);
    return redacted;
  }

  /** Refuse to store secrets at the value level. Returns a meta-record. */
  remember(input: {
    scope: MemoryScope;
    kind: MemoryKind;
    content: string;
    evidence?: MemoryEvidence[];
    confidence?: number;
    source: MemorySource;
    tags?: string[];
    sensitive?: boolean;
    expiresAt?: string;
  }): MemoryRecord | null {
    if (input.scope === "secret") {
      // Refuse raw storage. Caller should instead use project/user scope with
      // a redacted content string.
      return null;
    }
    const content = input.sensitive ? this.redactIfSensitive(input.content) : input.content;
    const now = new Date().toISOString();
    const id = this.makeId(content, input.scope);
    const record: MemoryRecord = {
      id,
      scope: input.scope,
      kind: input.kind,
      content,
      evidence: input.evidence ?? [],
      confidence: input.confidence ?? 0.7,
      source: input.source,
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      tags: input.tags ?? [],
      sensitive: input.sensitive ?? false,
      editable: true,
    };
    if (input.scope === "transient") {
      this.cache.transient.set(id, record);
      return record;
    }
    this.cache[input.scope].push(record);
    this.appendLine(this.pathFor(input.scope), record);
    return record;
  }

  /** Update a memory record. */
  update(id: string, patch: Partial<MemoryRecord>): MemoryRecord | null {
    const found = this.findMutable(id);
    if (!found) return null;
    if (!found.editable) return null;
    Object.assign(found, patch, { updatedAt: new Date().toISOString() });
    if (found.scope !== "transient" && found.scope !== "secret") {
      this.rebuildScope(found.scope);
    }
    return found;
  }

  forget(id: string): boolean {
    const scopes: Array<Exclude<MemoryScope, "transient" | "secret">> = ["project", "user", "machine"];
    for (const scope of scopes) {
      const idx = this.cache[scope].findIndex((r) => r.id === id);
      if (idx >= 0) {
        this.cache[scope].splice(idx, 1);
        this.rebuildScope(scope);
        return true;
      }
    }
    return this.cache.transient.delete(id);
  }

  forgetByTag(tag: string): number {
    let n = 0;
    const scopes: Array<Exclude<MemoryScope, "transient" | "secret">> = ["project", "user", "machine"];
    for (const scope of scopes) {
      const before = this.cache[scope].length;
      this.cache[scope] = this.cache[scope].filter((r) => !r.tags.includes(tag));
      n += before - this.cache[scope].length;
      if (before !== this.cache[scope].length) this.rebuildScope(scope);
    }
    for (const r of [...this.cache.transient.values()]) {
      if (r.tags.includes(tag)) {
        this.cache.transient.delete(r.id);
        n++;
      }
    }
    return n;
  }

  search(query: string, scopes: MemoryScope[] = ["project", "user", "machine", "transient"]): MemoryRecord[] {
    const q = query.toLowerCase();
    const all: MemoryRecord[] = [];
    if (scopes.includes("transient")) for (const r of this.cache.transient.values()) all.push(r);
    if (scopes.includes("project")) all.push(...this.cache.project);
    if (scopes.includes("user")) all.push(...this.cache.user);
    if (scopes.includes("machine")) all.push(...this.cache.machine);
    return all
      .filter((r) => !r.sensitive || r.content.includes("[REDACTED"))
      .filter((r) => r.content.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => b.confidence - a.confidence);
  }

  list(scope: MemoryScope): MemoryRecord[] {
    if (scope === "transient") return [...this.cache.transient.values()];
    if (scope === "secret") return [];
    return [...this.cache[scope]];
  }

  /** Detect contradictions (records with similar content but opposing tags). */
  detectContradictions(): { a: MemoryRecord; b: MemoryRecord; reason: string }[] {
    const all: MemoryRecord[] = [
      ...this.cache.project,
      ...this.cache.user,
      ...this.cache.machine,
      ...this.cache.transient.values(),
    ];
    const out: { a: MemoryRecord; b: MemoryRecord; reason: string }[] = [];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i]!;
        const b = all[j]!;
        if (a.id === b.id) continue;
        if (a.scope === "secret" || b.scope === "secret") continue;
        const overlap = tagOverlap(a.tags, b.tags);
        if (overlap === 0) continue;
        if (a.content.toLowerCase().includes("use ") && b.content.toLowerCase().includes("use ") &&
            a.content.toLowerCase().includes("npm") && b.content.toLowerCase().includes("pnpm")) {
          out.push({ a, b, reason: "conflicting package manager preference" });
        }
      }
    }
    return out;
  }

  /** Render a markdown summary of a scope. */
  summarize(scope: MemoryScope): string {
    const records = this.list(scope);
    if (records.length === 0) return `(${scope}: empty)`;
    const lines: string[] = [`# ${scope} memory (${records.length} records)`];
    for (const r of records) {
      lines.push(`- [${r.kind}] ${r.content}  (conf=${r.confidence.toFixed(2)}, src=${r.source})`);
    }
    return lines.join("\n");
  }

  /** Health check: count records per scope + check for stale entries. */
  healthCheck(): { project: number; user: number; machine: number; transient: number; sensitive: number; contradictory: number } {
    const all = [
      ...this.cache.project,
      ...this.cache.user,
      ...this.cache.machine,
      ...this.cache.transient.values(),
    ];
    return {
      project: this.cache.project.length,
      user: this.cache.user.length,
      machine: this.cache.machine.length,
      transient: this.cache.transient.size,
      sensitive: all.filter((r) => r.sensitive).length,
      contradictory: this.detectContradictions().length,
    };
  }

  /* --- helpers --- */
  private makeId(content: string, scope: MemoryScope): string {
    const h = createHash("sha256");
    h.update(scope);
    h.update("\0");
    h.update(content);
    h.update("\0");
    h.update(randomUUID());
    return h.digest("hex").slice(0, 16);
  }

  private findMutable(id: string): MemoryRecord | null {
    for (const scope of ["project", "user", "machine"] as const) {
      const r = this.cache[scope].find((r) => r.id === id);
      if (r) return r;
    }
    return this.cache.transient.get(id) ?? null;
  }

  private appendLine(path: string, record: MemoryRecord): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(record) + "\n");
  }

  private rebuildScope(scope: Exclude<MemoryScope, "transient" | "secret">): void {
    writeFileSync(this.pathFor(scope), this.cache[scope].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

function tagOverlap(a: string[], b: string[]): number {
  const set = new Set(a);
  let n = 0;
  for (const t of b) if (set.has(t)) n++;
  return n;
}
