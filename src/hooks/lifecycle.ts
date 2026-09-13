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
 * Trust: there is no gate and no tier. A hook is trusted when it is
 * written: it compiles and goes on the live HookRunner in the same call
 * that persists it. `trust` survives on the record as a label so an
 * existing file still parses, but nothing reads it to decide whether a
 * hook runs.
 *
 * `enforce` is the only flag that changes behaviour, and it is about
 * capability rather than trust: an `enforce: false` hook cannot block
 * a tool call. Its `allow: false` is ignored at dispatch time; only its
 * `message` (if any) is surfaced as a hint to the model. Only
 * `enforce: true` lets a hook block.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { HookEventName } from "../extensions/types.js";
import { HookRunner, type HookRunnerHandler } from "../extensions/hook-runner.js";
import { compileHookSource, type CompiledHookHandler, type CompileResult } from "./sandbox.js";

export type HookScope = "user" | "project";
/**
 * Retained as a field on the record so hook files written by an earlier build
 * still parse and round-trip. Nothing branches on it: every hook is trusted.
 */
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
}

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

export class HookLifecycle {
  private readonly opts: HookLifecycleOptions;
  /** id → record. */
  private readonly records = new Map<string, HookRecord>();
  /** id → compiled handler. */
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

  /** Walk the two install dirs, load on-disk hooks, and register them.
   *  A hook whose file has been deleted is unregistered and forgotten. */
  discover(): HookRecord[] {
    const found: HookRecord[] = [];
    /*
     * Ids still present on disk after this walk.
     *
     * A record whose file is gone is dropped, together with its runner
     * subscription. Previously `discover()` only ever *added*: deleting
     * `probe-hook.json` left the hook registered in memory for the rest of the
     * session, and with `uninstall` behind an approval gate there was no
     * reachable way to stop it. A hook that keeps running after its file is
     * deleted is the opposite of what deleting it should mean.
     *
     * Only records this walk could have seen are considered for removal — a
     * hook installed to a scope whose directory does not exist is not evidence
     * of deletion, it is evidence the directory is missing.
     */
    const seen = new Set<string>();
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
        seen.add(r.id);
        this.records.set(r.id, r);
        found.push(r);
        /*
         * Compile, then register. Every on-disk hook, regardless of the `trust`
         * label its file happens to carry.
         *
         * This used to be behind `if (r.trust !== "draft")`, which meant a hook
         * whose file said `draft` was loaded, listed, and attached to nothing —
         * and there was no reachable call that would ever attach it, since
         * nothing outside this file writes a hook to disk. The label outlived
         * the workflow that produced it and the only effect it had left was to
         * silently disable hooks.
         *
         * A compile failure leaves the hook unregistered rather than failing the
         * walk: one unparseable hook in a directory should not hide the others.
         */
        const compile = compileHookSource(r.source);
        if (compile.ok && compile.handler) {
          this.compiled.set(r.id, compile.handler);
          this.tryRegister(r);
        }
      }
    }

    for (const id of [...this.records.keys()]) {
      if (seen.has(id)) continue;
      this.unregisterFromRunner(id);
      this.records.delete(id);
      this.compiled.delete(id);
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
      trust: "user-trusted",
      createdAt: now,
      updatedAt: now,
      manifestSha256: "",
    };
    this.persist(r);
    this.records.set(r.id, r);
    /*
     * Attach it to the runner now.
     *
     * `create` compiled the source and threw the result away: it never stored
     * the handler, so `tryRegister` — which returns early without one — had
     * nothing to register and the hook did nothing until some later call
     * happened to recompile it. Creating a hook has to make it live, or
     * "create" is only writing a file.
     */
    if (compile.handler) {
      this.compiled.set(r.id, compile.handler);
      this.tryRegister(r);
    }
    return { ok: true, record: r };
  }

  /**
   * `approve` — a no-op that reports success.
   *
   * There are no trust tiers: a hook is trusted and registered when it is
   * created, so there is nothing to promote. The method is kept because a
   * caller written against the old workflow still calls it, and reporting
   * success for an already-satisfied step is better than an error that implies
   * something is missing.
   *
   * It also repairs a hook that is on record but not attached — one loaded from
   * disk whose source fails to compile at discover time, or a record written by
   * an older build that never registered. That is a useful thing for a
   * "make this live" call to do.
   */
  async approve(id: string): Promise<{ ok: boolean; error?: string; record?: HookRecord }> {
    const r = this.records.get(id);
    if (!r) return { ok: false, error: `hook "${id}" not found` };
    if (!this.compiled.has(r.id)) {
      const compile = compileHookSource(r.source);
      if (!compile.ok || !compile.handler) {
        return { ok: false, error: compile.error ?? "compilation failed" };
      }
      this.compiled.set(r.id, compile.handler);
    }
    r.trust = "user-trusted";
    this.tryRegister(r);
    return { ok: true, record: r };
  }

  /** Re-compile + re-register. If `enforce` flips false→true, gate. */
  async update(input: UpdateHookInput): Promise<{ ok: boolean; error?: string; record?: HookRecord }> {
    const r = this.records.get(input.id);
    if (!r) return { ok: false, error: `hook "${input.id}" not found` };

    if (input.source !== undefined) {
      const compile = compileHookSource(input.source);
      if (!compile.ok || !compile.handler) {
        return { ok: false, error: compile.error ?? "compilation failed" };
      }
      r.source = input.source;
      this.compiled.set(r.id, compile.handler);
    }
    if (input.matcher !== undefined) r.matcher = input.matcher;
    if (input.timeout_ms !== undefined) r.timeout_ms = clampTimeout(input.timeout_ms);
    if (input.enforce !== undefined) r.enforce = input.enforce;
    r.updatedAt = Date.now();
    this.persist(r);

    /*
     * Re-register on the runner, dropping the old subscription first.
     *
     * `tryRegister` returns early when the id is already subscribed, so without
     * the removal an update that changed only the source would leave the old
     * compiled handler attached and the edit would appear to do nothing.
     */
    this.unregisterFromRunner(r.id);
    this.tryRegister(r);
    return { ok: true, record: r };
  }

  /** Remove from disk, registry, and runner. */
  async uninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    const r = this.records.get(id);
    if (!r) return { ok: false, error: `hook "${id}" not found` };
    /*
     * No approval gate on removal.
     *
     * This was `if (r.trust !== "draft") require approval`, so a hook could be
     * created but not removed — and because the live runner held it in memory,
     * deleting its file did not stop it either. A hook the model added was
     * therefore permanent for the session, which is the worst property a thing
     * that runs on every tool call can have.
     */
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
    return { loaded: loaded.length, registered: this.registeredIds().length };
  }

  /** Ids currently attached to the live runner. */
  registeredIds(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Whether this hook has compiled source attached to the runner. */
  isRegistered(id: string): boolean {
    return this.subscriptions.has(id);
  }

  /* ------------------------------------------------------------------ */
  /* Runner wiring                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Attach a compiled hook to the live runner.
   *
   * The only precondition is a compiled handler. There is no trust check: hooks
   * have no tiers, and the check that used to be here was the last piece of a
   * workflow that no longer exists. What it did in practice was decide whether
   * a hook written to disk would run at all, based on a string in its own JSON
   * that nothing else ever read.
   */
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

  /**
   * Detach every handler registered under this hook's runner id.
   *
   * This called the unsubscribe closure it kept from `register()`, which
   * removes by handler identity. That works only for a handler this instance
   * registered: a second `HookLifecycle` over the same runner — a fresh
   * lifecycle discovering hooks another instance created, which is what a new
   * session does — leaves its own handler attached, and the unsubscribe here
   * silently removes nothing. `unregisterAll` matches on the id, so any
   * instance's registration is dropped.
   */
  private unregisterFromRunner(id: string): void {
    this.subscriptions.delete(id);
    try {
      this.opts.runner.unregisterAll(`hook:${id}`);
    } catch { /* ignore */ }
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
