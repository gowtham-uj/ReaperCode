/**
 * Code Mode's runtime lifetime.
 *
 * A runtime is created once per *run* and reused across that run's eval calls.
 * The decision that matters is where the key comes from.
 *
 * The obvious key is the thread, and it is the wrong one. Two isolated agent
 * runs — a sub-agent, a role-scoped turn, a forked task — can share a thread,
 * and a runtime keyed on the thread would hand the second one the first one's
 * state. Isolation is the property the spec asks for unconditionally, so the
 * key is the run: `runId` is already the identity Reaper uses for a workspace,
 * a log directory, and a trajectory, and two runs that share it are the same
 * run by definition.
 *
 * **The runtime is per-run, but the state in it is per-eval.** That is the
 * thing to know before reading the rest of this file. The QuickJS runtime this
 * replaced kept one interpreter alive across a run, so a `const` from eval #1
 * was visible in eval #2; the worker runtime cannot, because the thread that
 * holds those variables is the same thread `terminate()` kills to stop a
 * runaway script. Keeping the state would mean keeping a killed script's
 * half-finished work alive for the next one. Fresh-per-eval is the safer
 * contract and it is the one the model is told about, in the tool description,
 * in the skill, and in the hint attached to the `ReferenceError` it produces.
 *
 * What the per-run entry still buys is that the run's *limits and identity* are
 * resolved once and disposed deterministically, so an abandoned run does not
 * leave anything behind.
 *
 * The other thing this file owns is the *tool surface* being stable for as long
 * as a runtime lives. `search_tools` promotes a tool for a later turn, and the
 * surface a run's runtime was built with would then be a turn out of date — a
 * model told it may call `web_fetch` that finds `tools.web_fetch` undefined.
 * The surface is frozen at the run's first eval and `surfaceChanged` keeps a
 * later, wider surface from silently replacing one the model is already using.
 * The trade is stated in the result the model gets, not hidden.
 */

import type {
  CodeOutputChunk,
  CodeRuntimeLimits,
  CodeRuntimeResult,
  CodeToolCallRecord,
  CodeToolDescriptor,
  CodeToolHost,
} from "./types.js";

interface SessionEntry {
  runtime: RuntimeLike;
  /**
   * The descriptor set the run's `tools` surface was frozen from. Held so a
   * later call with a different surface is *noticed* rather than silently
   * applied.
   */
  surface: readonly CodeToolDescriptor[];
  /** True once a call has actually run against this runtime's bridge. */
  surfaceBound: boolean;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
}

/**
 * One run's slot in the queue, existing before the runtime does.
 *
 * The slot and the runtime are separate because they have to be created at
 * different times. The slot is claimed *synchronously*, so two eval calls that
 * arrive in the same tick are ordered rather than racing; the runtime is built
 * inside that claim, and building it is asynchronous.
 *
 * An earlier version kept the queue on the entry and defaulted the first
 * entry's tail to `new Promise(() => undefined)` — a promise that never
 * settles. Nothing resolved it, because the resolver was only ever installed on
 * the *reuse* path, so the first call's release was a no-op and every
 * subsequent call for that run awaited it forever. The single-eval case worked,
 * which is why it survived: the hang needed a second call in the same run.
 */
interface SessionSlot {
  /** Tail of the queue. One WASM runtime runs one script at a time. */
  chain: Promise<void>;
  entry?: SessionEntry | undefined;
}

/** The slice of the runtime this module uses, so the WASM import stays lazy. */
interface RuntimeLike {
  readonly alive: boolean;
  run(options: SessionRunOptions): Promise<CodeRuntimeResult>;
  dispose(): void;
}

export interface SessionRunOptions {
  source: string;
  tools: readonly CodeToolDescriptor[];
  host: CodeToolHost;
  signal?: AbortSignal;
  limits?: Partial<CodeRuntimeLimits>;
  /**
   * The thread's workspace, and the root the sandbox confines the script to.
   *
   * Read here as well as by the runtime because the runtime is built once per
   * run and the confinement decision is made at that moment: a run whose first
   * eval has no workspace gets an unconfined runtime for its whole life.
   */
  workspace?: string;
  /**
   * Live view of the run, forwarded to the runtime. Present here rather than
   * read off the runtime because the runtime is shared across turns and the
   * sink belongs to the turn.
   */
  onOutput?: (chunk: CodeOutputChunk) => void;
  onToolCall?: (record: CodeToolCallRecord) => void;
}

export interface SessionOutcome {
  result: CodeRuntimeResult;
  /**
   * True when the tool surface for this run had already changed by the time
   * this call arrived, so the runtime used a surface that is one turn
   * behind. Reported rather than corrected: see the note at the top.
   */
  surfaceChanged: boolean;
}

const slots = new Map<string, SessionSlot>();

/**
 * Take a place in this key's queue, synchronously.
 *
 * Synchronous is the whole contract. Reading the previous chain, replacing it,
 * and capturing the resolver all happen in one block with no `await` between
 * them, so two calls arriving in the same tick cannot both observe the same
 * "previous". An earlier version did the swap after an `await`, which let three
 * simultaneous calls all read a settled chain and then run at once against one
 * shared context.
 */
function claimQueuePosition(sessionKey: string): { slot: SessionSlot; previous: Promise<void>; release: () => void } {
  let slot = slots.get(sessionKey);
  if (!slot) {
    slot = { chain: Promise.resolve() };
    slots.set(sessionKey, slot);
  }
  const previous = slot.chain;
  let release!: () => void;
  slot.chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { slot, previous, release };
}

/**
 * How long a run's runtime entry survives after its last eval.
 *
 * A run that has ended will never eval again, and its runtime holds a WASM heap
 * and a context. There is no end-of-run hook on the executor to hang disposal
 * off — `cleanupBackgroundProcesses` is called at run end *and* mid-run — so
 * the lifetime is bounded by idleness instead. Ten minutes is far longer than
 * the gap between two evals in one turn and far shorter than the process.
 */
const IDLE_DISPOSAL_MS = 10 * 60 * 1000;

/**
 * Run one eval against its run's entry, creating it on first use.
 *
 * The entry is claimed before the first `await`, so two eval calls that arrive
 * together cannot both construct a runtime for the same run; the second waits
 * for the first to finish. Serialising them is the honest behaviour — one WASM
 * runtime cannot run two scripts at once, and a caller that wanted parallelism
 * would be getting an illusion of it.
 */
export async function runInSession(sessionKey: string, options: SessionRunOptions): Promise<SessionOutcome> {
  const { slot, previous, release: releaseCurrent } = claimQueuePosition(sessionKey);

  /*
   * The runtime is built while holding the queue position, which is what makes
   * `acquire` race-free: the caller that gets here is the only one that can be
   * constructing a runtime for this key.
   */
  const entry = await acquire(slot, options);
  await previous;

  const changed = entry.surfaceBound && differs(entry.surface, options.tools);
  entry.surfaceBound = true;
  try {
    /*
     * Per-call limits are applied per call, never stored.
     *
     * `acquire` builds the runtime once for a session key and reuses it, so the
     * limits it was constructed with become that session's baseline. `run()`
     * merges a caller's `limits` over that baseline — which is right — but the
     * merge happened against whatever a *previous* call had passed in when the
     * runtime was first built. Measured: a call asking for `timeout_ms: 1000`
     * left every later call in the same session with a one-second deadline, and
     * the script after it — a three-second sleep — was killed at 1010ms with no
     * sign of why.
     *
     * That is a bad bug for a per-call override to have, because the failure is
     * invisible: the model asks for a short deadline on a quick probe, and its
     * next, longer script dies for a reason nothing in the transcript explains.
     * So the runtime is built with the *defaults* and every call's own limits
     * are layered on top at run time, where they belong.
     */
    const result = await entry.runtime.run({ ...options, tools: entry.surface });
    return { result, surfaceChanged: changed };
  } finally {
    releaseCurrent();
    release(slot, entry);
  }
}

/** Dispose a run's runtime, if it has one. Called when a run is abandoned. */
export function disposeSession(sessionKey: string): void {
  const slot = slots.get(sessionKey);
  if (!slot) return;
  slots.delete(sessionKey);
  const entry = slot.entry;
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.runtime.dispose();
}

/** Stop a running script. Its dispatch will finish with a cancelled result. */
export function interruptSession(sessionKey: string): void {
  const entry = slots.get(sessionKey)?.entry;
  if (!entry) return;
  (entry.runtime as { requestDispose?(): void }).requestDispose?.();
}

/** Test and diagnostic hook: how many runs currently hold a runtime. */
export function sessionCount(): number {
  let count = 0;
  for (const slot of slots.values()) if (slot.entry) count += 1;
  return count;
}

/**
 * Get this slot's live runtime, building one if it has none.
 *
 * Called only while holding the slot, so there is no race to lose: the caller
 * that reaches here is the only one that can be constructing a runtime for this
 * key.
 */
async function acquire(slot: SessionSlot, options: SessionRunOptions): Promise<SessionEntry> {
  const existing = slot.entry;
  if (existing && existing.runtime.alive) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = undefined;
    }
    return existing;
  }
  if (existing) existing.runtime.dispose();

  /*
   * Still loaded lazily, for a smaller reason than before.
   *
   * Under QuickJS this mattered a lot: that build inlines its WASM as a
   * megabyte of base64, and a static import put it on the startup path of every
   * process including the ones that never call eval. The Node runtime carries
   * no such payload — it is a worker and a string — but the deferral costs
   * nothing and keeps `worker_threads` off the boot path.
   */
  const { ReaperNodeRuntime } = await import("./node-runtime.js");
  /*
   * Built with the defaults, not with this call's overrides.
   *
   * The entry outlives the call that created it, so anything passed here
   * becomes the session's standing configuration for every later call — see the
   * note in `runInSession`. A caller's `limits` are applied per run, where they
   * cannot outlive the script that asked for them.
   */
  const runtime = (await ReaperNodeRuntime.create(undefined, options.workspace)) as unknown as RuntimeLike;

  const entry: SessionEntry = { runtime, surface: options.tools, surfaceBound: false };
  slot.entry = entry;
  return entry;
}

function release(slot: SessionSlot, entry: SessionEntry): void {
  if (!entry.runtime.alive) {
    slot.entry = undefined;
    for (const [key, value] of slots) if (value === slot) slots.delete(key);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    if (slot.entry !== entry) return;
    slot.entry = undefined;
    for (const [key, value] of slots) if (value === slot) slots.delete(key);
    entry.runtime.dispose();
  }, IDLE_DISPOSAL_MS);
  // A pending runtime must not hold the process open by itself.
  entry.idleTimer.unref?.();
}

/** Whether two tool surfaces differ in the way the runtime would notice. */
function differs(left: readonly CodeToolDescriptor[], right: readonly CodeToolDescriptor[]): boolean {
  if (left.length !== right.length) return true;
  const names = new Set(left.map((tool) => tool.name));
  return right.some((tool) => !names.has(tool.name));
}
