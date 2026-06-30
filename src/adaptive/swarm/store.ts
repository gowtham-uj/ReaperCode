/**
 * SubagentStore — per-instance persistence for a single subagent.
 *
 * Layout under `<workspace>/.reaper/swarm/<agentId>/`:
 *   context.jsonl     — subagent's own conversation (not visible to main)
 *   wire.jsonl        — chronological wire events (stages, tool calls, results, text, errors)
 *   meta.json         — AgentInstanceRecord snapshot
 *   prompt.txt        — initial prompt (debugging aid)
 *   output            — human-readable transcript
 *
 * The store is the only place subagent state lives. The main agent
 * never reads context.jsonl — only `output` (or, in foreground mode,
 * the structured `SubagentResult.summary`).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

import type { AgentInstanceRecord, AgentLaunchSpec, SubagentStatus, WireEvent } from "./types.js";

const VALID_STATUSES: SubagentStatus[] = ["idle", "running_foreground", "running_background", "completed", "failed", "killed"];

export interface SubagentStoreOptions {
  workspaceRoot: string;
}

export class SubagentStore {
  private readonly root: string;

  constructor(opts: SubagentStoreOptions) {
    this.root = join(opts.workspaceRoot, ".reaper", "swarm");
    mkdirSync(this.root, { recursive: true });
  }

  /** Path of a per-instance directory. */
  instanceDir(agentId: string, create = false): string {
    const p = join(this.root, agentId);
    if (create) mkdirSync(p, { recursive: true });
    return p;
  }

  /** Per-instance file paths. */
  contextPath(agentId: string): string { return join(this.instanceDir(agentId, true), "context.jsonl"); }
  wirePath(agentId: string): string { return join(this.instanceDir(agentId, true), "wire.jsonl"); }
  metaPath(agentId: string): string { return join(this.instanceDir(agentId, true), "meta.json"); }
  promptPath(agentId: string): string { return join(this.instanceDir(agentId, true), "prompt.txt"); }
  outputPath(agentId: string): string { return join(this.instanceDir(agentId, true), "output"); }

  /** Create a new instance, return its record. */
  createInstance(input: { agentId: string; description: string; launchSpec: AgentLaunchSpec }): AgentInstanceRecord {
    const now = new Date().toISOString();
    this.initializeFiles(input.agentId);
    const record: AgentInstanceRecord = {
      agentId: input.agentId,
      subagentType: input.launchSpec.subagentType,
      status: "idle",
      description: input.description,
      createdAt: now,
      updatedAt: now,
      lastTaskId: null,
      launchSpec: input.launchSpec,
    };
    this.writeInstance(record);
    return record;
  }

  /** Write the instance record to disk. */
  writeInstance(record: AgentInstanceRecord): void {
    const dir = this.instanceDir(record.agentId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.metaPath(record.agentId), JSON.stringify(record, null, 2));
  }

  /** Read the instance record. Returns null if missing. */
  readInstance(agentId: string): AgentInstanceRecord | null {
    const p = this.metaPath(agentId);
    if (!existsSync(p)) return null;
    try {
      const obj = JSON.parse(readFileSync(p, "utf8")) as AgentInstanceRecord;
      if (!VALID_STATUSES.includes(obj.status)) {
        throw new Error(`invalid subagent status: ${obj.status}`);
      }
      return obj;
    } catch {
      return null;
    }
  }

  /** Throw if the instance is missing. */
  requireInstance(agentId: string): AgentInstanceRecord {
    const r = this.readInstance(agentId);
    if (!r) throw new Error(`subagent instance not found: ${agentId}`);
    return r;
  }

  /** Update fields on the instance record. */
  updateInstance(agentId: string, patch: Partial<AgentInstanceRecord>): AgentInstanceRecord {
    const r = this.requireInstance(agentId);
    const next: AgentInstanceRecord = { ...r, ...patch, updatedAt: new Date().toISOString() };
    this.writeInstance(next);
    return next;
  }

  /** Update only the status field. */
  setStatus(agentId: string, status: SubagentStatus): void {
    this.updateInstance(agentId, { status });
  }

  /** Append a wire event. */
  appendWire(agentId: string, event: WireEvent): void {
    appendFileSync(this.wirePath(agentId), JSON.stringify(event) + "\n");
  }

  /** Save the initial prompt. */
  writePrompt(agentId: string, prompt: string): void {
    writeFileSync(this.promptPath(agentId), prompt);
  }

  /** List all instances. */
  list(): AgentInstanceRecord[] {
    if (!existsSync(this.root)) return [];
    const out: AgentInstanceRecord[] = [];
    for (const name of readdirSync(this.root)) {
      const dir = join(this.root, name);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const r = this.readInstance(name);
      if (r) out.push(r);
    }
    return out;
  }

  /** Cancel and remove an instance. Returns true if removed. */
  delete(agentId: string): boolean {
    const dir = this.instanceDir(agentId);
    if (!existsSync(dir)) return false;
    rmrf(dir);
    return true;
  }

  /** Build a new launch spec with a fresh agentId. */
  static newAgentId(): string {
    return `a${randomUUID().slice(0, 8)}`;
  }

  /* --- private --- */
  private initializeFiles(agentId: string): void {
    const dir = this.instanceDir(agentId, true);
    for (const f of ["context.jsonl", "wire.jsonl"]) {
      const p = join(dir, f);
      if (!existsSync(p)) writeFileSync(p, "");
    }
    if (!existsSync(this.outputPath(agentId))) writeFileSync(this.outputPath(agentId), "");
  }
}

function rmrf(p: string): void {
  try {
    for (const ent of readdirSync(p)) {
      const sub = join(p, ent);
      try {
        const st = statSync(sub);
        if (st.isDirectory()) rmrf(sub);
        else unlinkSync(sub);
      } catch { /* ignore */ }
    }
    rmdirSync(p);
  } catch { /* ignore */ }
}

/** Helpers to read a stored context (used by prepare.ts on resume). */
export function readContextMessages(agentId: string, store: SubagentStore): string[] {
  const p = store.contextPath(agentId);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

export { dirname };
