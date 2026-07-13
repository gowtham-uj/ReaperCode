/**
 * HookLifecycle — the persistence + registration layer for
 * model-authored hooks. Hooks are independent of extensions: a hook
 * is a `(event, matcher, JS handler)` triple stored as JSON on disk,
 * compiled with `new Function('event', body)` (see sandbox.ts), and
 * registered on the live `HookRunner`.
 *
 * Storage layout:
 *   <userHome>/.reaper/hooks/<id>.json   — user scope
 *   <workspaceRoot>/.reaper/hooks/<id>.json — project scope
 *
 * Trust gate: every hook lands as `draft` and is NOT registered on
 * the live HookRunner until `approve()` is called. The `approve()`
 * call is gated by the `ApprovalRequester` callback (typically
 * `request_human_approval` from the tool surface). On approval the
 * compiled handler is registered; on denial the hook stays a draft.
 *
 * Enforce flag: even when approved, an `enforce: false` hook cannot
 * block a tool call. Its `allow: false` is ignored at dispatch time;
 * only its `message` (if any) is surfaced as a hint to the model.
 * Only `enforce: true` lets the hook block.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { HookEventName } from "../extensions/types.js";
import { HookRunner, type HookRunnerHandler } from "../extensions/hook-runner.js";
import { compileHookSource, type CompiledHookHandler, type CompileResult } from "./sandbox.js";

export type HookScope = "user" | "project";
export type HookTrust = "draft" | "user-trusted" | "project-untrusted";

export interface HookMatcher {
  /** Path glob. Example patterns: a glob, or an absolute path. */
  path_glob?: string;
  /** Tool name. Example: bash. */
  tool_name?: string;
  /** Regex pattern matched against the tool cmd arg. */
  cmd_pattern?: string;
}

export interface HookRecord {
  /** Persisted on disk. */
  id: string;
  event: HookEventName;
  description: string;
  matcher: HookMatcher | null;
  /** Original JS source. Preserved for re-compilation. */
  source: string;
  timeout_ms: number;
  enforce: boolean;
  scope: HookScope;
  trust: HookTrust;
  createdAt: number;
  updatedAt: number;
  /** sha256 of the on-disk JSON. */
  manifestSha256: string;
}

export interface CreateHookInput {
  id: string;
  event: HookEventName;
  description: string;
  matcher?: HookMatcher | null;
  source: string;
  timeout_ms?: number;
  enforce?: boolean;
  scope?: HookScope;
}

export interface UpdateHookInput {
  id: string;
  source?: string;
  matcher?: HookMatcher | null;
  timeout_ms?: number;
  enforce?: boolean;
}

export interface HookLifecycleOptions {
  /** Live HookRunner — handlers are registered / unregistered here. */
  runner: HookRunner;
  workspaceRoot: string;
  userHome: string;
  /** Approval gate. Returns true on user approval, false on denial. */
  approvalRequester?: ApprovalRequester;
}

/**
 * Approval gate. The model-callable approve_hook tool routes its
 * decision through this callback. The default is to require explicit
 * approval for any enforce: true hook, and auto-approve enforce: false
 * drafts (the user sees the source + enforce flag in the prompt).
 */
export type ApprovalRequester = (input: {
  kind: "hook_approve" | "hook_update" | "hook_uninstall";
  hook: HookRecord;
  /** The original source (or first 4KB of it) being approved. */
  sourcePreview: string;
  /** Whether the enforce flag is true (gating is blockable). */
  enforce: boolean;
}) => Promise<boolean> | boolean;

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const SOURCE_PREVIEW_BYTES = 4096;

export class HookLifecycle {
  private readonly opts: HookLifecycleOptions;
  /** id → record. */
  private readonly records = new Map<string, HookRecord>();
  /** id → compiled handler (only for approved hooks). */
  private readonly compiled = new Map<string, CompiledHookHandler>();
  /** id → unsubscribe function from the HookRunner. */
  private readonly subscriptions = new Map<string, () => void>();

  constructor(opts: HookLifecycleOptions) {
    this.opts = opts;
    this.discover();
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                          */
  /* ------------------------------------------------------------------ */

  /** Walk the two install dirs and load any on-disk hooks. Drafts
   *  are loaded into `records` but NOT registered. Approved hooks
   *  are compiled and registered on the live HookRunner. */
  discover(): HookRecord[] {
    const found: HookRecord[] = [];
    for (const dir of [this.hooksDir("user"), this.hooksDir("project")]) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.endsWith(".json"));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.replace(/\.json$/, "");
        const raw = readFileSync(join(dir, name), "utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const r = recordFromDisk(parsed, id);
        if (!r) continue;
        this.records.set(r.id, r);
        found.push(r);
        if (r.trust !== "draft") this.tryRegister(r);
      }
    }
    return found;
  }

  /** Persist a record to disk. The file is named `<id>.json` in the
   *  scope's hooks dir. */
  private persist(r: HookRecord): { path: string; sha256: string } {
    const dir = this.hooksDir(r.scope);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${r.id}.json`);
    const json = JSON.stringify(recordToDisk(r), null, 2);
    writeFileSync(filePath, json);
    const sha256 = createHash("sha256").update(json).digest("hex");
    r.manifestSha256 = sha256;
    return { path: filePath, sha256 };
  }

  private hooksDir(scope: HookScope): string {
    return scope === "user"
      ? join(this.opts.userHome, ".reaper", "hooks")
      : join(this.opts.workspaceRoot, ".reaper", "hooks");
  }

  /* ------------------------------------------------------------------ */
  /* CRUD                                                                 */
  /* ------------------------------------------------------------------ */

  /** Author a new hook. Lands as `draft` on disk; not registered. */
  create(input: CreateHookInput): { ok: boolean; error?: string; record?: HookRecord } {
    const idCheck = checkId(input.id);
    if (idCheck) return { ok: false, error: idCheck };
    if (this.records.has(input.id)) return { ok: false, error: `hook "${input.id}" already exists` };

    const compile = compileHookSource(input.source);
    if (!compile.ok) return { ok: false, error: compile.error ?? "compilation failed" };

    const now = Date.now();
    const r: HookRecord = {
      id: input.id,
      event: input.event,
      description: input.description,
      matcher: input.matcher ?? null,
      source: input.source,
      timeout_ms: clampTimeout(input.timeout_ms ?? DEFAULT_TIMEOUT_MS),
      enforce: input.enforce ?? false,
      scope: input.scope ?? "project",
      trust: "draft",
      createdAt: now,
      updatedAt: now,
      manifestSha256: "",
    };
    this.persist(r);
    this.records.set(r.id, r);
    return { ok: true, record: r };
  }

  /** Compile and register an existing draft. Gated by the
   *  ApprovalRequester. */
  async approve(id: string): Promise<{ ok: boolean; error?: string; record?: HookRecord }> {
    const r = this.records.get(id);
    if (!r) return { ok: false, error: `hook "${id}" not found` };
    if (r.trust !== "draft") return { ok: false, error: `hook "${id}" is already ${r.trust}` };

    // Approval gate.
    const approved = await this.askApproval(r);
    if (!approved) return { ok: false, error: "denied by approval gate" };

    // Compile + register.
    const compile = compileHookSource(r.source);
    if (!compile.ok || !compile.handler) {
      return { ok: false, error: compile.error ?? "compilation failed" };
    }
    this.compiled.set(r.id, compile.handler);
    r.trust = r.scope === "user" ? "user-trusted" : "project-untrusted";
    r.updatedAt = Date.now();
    this.tryRegister(r);
    this.persist(r);
    return { ok: true, record: r };
  }

  /** Re-compile + re-register. If `enforce` flips false→true, gate. */
  async update(input: UpdateHookInput): Promise<{ ok: boolean; error?: string; record?: HookRecord }> {
    const r = this.records.get(input.id);
    if (!r) return { ok: false, error: `hook "${input.id}" not found` };

    const enforceFlipped = (input.enforce === true) && r.enforce === false;
    if (enforceFlipped) {
      const approved = await this.askApproval(r, { ...r, enforce: true });
      if (!approved) return { ok: false, error: "denied: enforce flip requires approval" };
    }

    if (input.source !== undefined) {
      const compile = compileHookSource(input.source);
      if (!compile.ok || !compile.handler) {
        return { ok: false, error: compile.error ?? "compilation failed" };
      }
      r.source = input.source;
      if (r.trust !== "draft") {
        this.compiled.set(r.id, compile.handler);
      }
    }
    if (input.matcher !== undefined) r.matcher = input.matcher;
    if (input.timeout_ms !== undefined) r.timeout_ms = clampTimeout(input.timeout_ms);
    if (input.enforce !== undefined) r.enforce = input.enforce;
    r.updatedAt = Date.now();
    this.persist(r);

    // Re-register on the runner (drop the old subscription first).
    if (r.trust !== "draft") {
      this.unregisterFromRunner(r.id);
      this.tryRegister(r);
    }
    return { ok: true, record: r };
  }

  /** Remove from disk, registry, and runner. */
  async uninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.records.get(id);
    if (!r) return { ok: false, error: `hook "${id}" not found` };
    if (r.trust !== "draft") {
      const approved = await this.askApproval(r, undefined, "hook_uninstall");
      if (!approved) return { ok: false, error: "denied: uninstall requires approval" };
    }
    this.unregisterFromRunner(r.id);
    this.records.delete(r.id);
    this.compiled.delete(r.id);
    const filePath = join(this.hooksDir(r.scope), `${r.id}.json`);
    if (existsSync(filePath)) {
      try { rmSync(filePath, { force: true }); } catch { /* ignore */ }
    }
    return { ok: true };
  }

  /** List registered + draft hooks. */
  list(): HookRecord[] {
    return [...this.records.values()];
  }

  get(id: string): HookRecord | null {
    return this.records.get(id) ?? null;
  }

  /** Used by `reload_hooks` to wipe and re-walk the disk. */
  reload(): { loaded: number; registered: number } {
    // Unregister everything.
    for (const id of this.records.keys()) this.unregisterFromRunner(id);
    this.records.clear();
    this.compiled.clear();
    this.subscriptions.clear();
    const loaded = this.discover();
    return { loaded: loaded.length, registered: loaded.filter((r) => r.trust !== "draft").length };
  }

  /* ------------------------------------------------------------------ */
  /* Runner wiring                                                        */
  /* ------------------------------------------------------------------ */

  private tryRegister(r: HookRecord): void {
    if (this.subscriptions.has(r.id)) return; // already registered
    const handler = this.compiled.get(r.id);
    if (!handler) return;
    const sub = this.opts.runner.register(
      `hook:${r.id}`,
      r.event,
      // Adapt the runner envelope to the hook's matcher / enforce shape.
      this.wrapHandler(r, handler),
      { timeoutMs: r.timeout_ms, blockable: r.enforce },
    );
    this.subscriptions.set(r.id, sub);
  }

  private unregisterFromRunner(id: string): void {
    const sub = this.subscriptions.get(id);
    if (sub) {
      try { sub(); } catch { /* ignore */ }
      this.subscriptions.delete(id);
    }
  }

  private wrapHandler(r: HookRecord, handler: CompiledHookHandler): HookRunnerHandler {
    return (env) => {
      // Apply matcher if present.
      if (r.matcher && !matcherAllows(r.matcher, env)) {
        return { allow: true };
      }
      // Apply enforce semantics.
      const out = handler({ name: env.event as string, payload: env.payload, blockable: env.blockable });
      if (!r.enforce) {
        // observe-only: ignore allow: false but pass through message.
        if (out && typeof (out as { then?: unknown }).then === "function") {
          return (out as Promise<{ allow: boolean; message?: string; reason?: string }>).then((r) => ({
            allow: true,
            ...(r.message ? { message: r.message } : {}),
          }));
        }
        const sync = out as { allow: boolean; message?: string; reason?: string };
        return { allow: true, ...(sync.message ? { message: sync.message } : {}) };
      }
      return out;
    };
  }

  /* ------------------------------------------------------------------ */
  /* Approval gate                                                        */
  /* ------------------------------------------------------------------ */

  private async askApproval(r: HookRecord, preview?: HookRecord, kind: "hook_approve" | "hook_update" | "hook_uninstall" = "hook_approve"): Promise<boolean> {
    if (!this.opts.approvalRequester) {
      // No approval gate wired — fail-closed by default for enforce hooks.
      return r.enforce === false && kind === "hook_approve" ? true : false;
    }
    const sourcePreview = (preview?.source ?? r.source).slice(0, SOURCE_PREVIEW_BYTES);
    return await this.opts.approvalRequester({
      kind,
      hook: r,
      sourcePreview,
      enforce: preview?.enforce ?? r.enforce,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function checkId(id: unknown): string | null {
  if (typeof id !== "string") return "id must be a string";
  if (!ID_REGEX.test(id)) return `id must match ${ID_REGEX.source}`;
  return null;
}

function clampTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(ms)));
}

function matcherAllows(
  m: HookMatcher,
  env: { event: string; payload: Record<string, unknown>; blockable: boolean },
): boolean {
  if (m.tool_name) {
    const toolName = typeof env.payload.toolName === "string" ? env.payload.toolName : "";
    if (toolName !== m.tool_name) return false;
  }
  if (m.path_glob) {
    const p = typeof env.payload.path === "string" ? env.payload.path : "";
    if (!p) return false;
    if (!globMatch(m.path_glob, p)) return false;
  }
  if (m.cmd_pattern) {
    const cmd = typeof env.payload.cmd === "string" ? env.payload.cmd : "";
    let re: RegExp;
    try { re = new RegExp(m.cmd_pattern); } catch { return false; }
    if (!re.test(cmd)) return false;
  }
  return true;
}

function globMatch(glob: string, path: string): boolean {
  // Minimal glob: ** matches any, * matches one segment.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*\\\*/g, "::DOUBLESTAR::")
    .replace(/\\\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function recordToDisk(r: HookRecord): Record<string, unknown> {
  return {
    id: r.id,
    event: r.event,
    description: r.description,
    matcher: r.matcher,
    source: r.source,
    timeout_ms: r.timeout_ms,
    enforce: r.enforce,
    scope: r.scope,
    trust: r.trust,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function recordFromDisk(parsed: unknown, fallbackId: string): HookRecord | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : fallbackId;
  if (!ID_REGEX.test(id)) return null;
  if (typeof o.event !== "string") return null;
  if (typeof o.description !== "string") return null;
  if (typeof o.source !== "string") return null;
  return {
    id,
    event: o.event as HookEventName,
    description: o.description,
    matcher: (o.matcher as HookMatcher | null) ?? null,
    source: o.source,
    timeout_ms: clampTimeout(typeof o.timeout_ms === "number" ? o.timeout_ms : DEFAULT_TIMEOUT_MS),
    enforce: o.enforce === true,
    scope: o.scope === "user" ? "user" : "project",
    trust: o.trust === "user-trusted" ? "user-trusted" : o.trust === "project-untrusted" ? "project-untrusted" : "draft",
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    manifestSha256: "",
  };
}
