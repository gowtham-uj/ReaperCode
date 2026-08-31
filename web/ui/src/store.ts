/**
 * The Solid application layer over the shared reducer.
 *
 * `web/shared` stays framework-agnostic — it is consumed by the BFF, the mock
 * fixture, and the parity test, none of which run a framework. This module is
 * the only place that knows Solid exists.
 *
 * Why not just hold `ThreadsState` in a signal: a token delta would replace the
 * root object, and every consumer would re-read. `createStore` diffs by path,
 * so writing the same state through `reconcile` updates exactly the leaves
 * that actually changed — one text node per token. The shared reducer stays
 * the definition of *what* a notification means; this decides *how* it lands.
 *
 * `tests/unit/solid-store-parity.test.ts` asserts the two agree.
 */

import { batch, createSignal } from "solid-js";
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store";

import {
  applyNotification,
  emptyThreads,
  type AppThread,
  type ApprovalRequest,
  type ThreadsState,
} from "@reaper/web-shared";

export interface TranscriptStore {
  threads: ThreadsState;
  setThreads: SetStoreFunction<ThreadsState>;
  /** Fold one notification in, updating only the paths that changed. */
  ingest(method: string, params: Record<string, unknown>): void;
  /** Replace state wholesale — the reconnect/hydrate path. */
  hydrate(next: ThreadsState): void;
  thread(id: string): AppThread | undefined;
}

export function createTranscriptStore(initial: ThreadsState = emptyThreads()): TranscriptStore {
  const [threads, setThreads] = createStore<ThreadsState>(initial);
  // The pure reducer needs an immutable snapshot to fold against; the store is
  // a proxy. This mirror is that snapshot, and never handed to the view.
  let mirror: ThreadsState = initial;

  return {
    threads,
    setThreads,
    ingest(method, params) {
      const next = applyNotification(mirror, method, params);
      if (next === mirror) return; // Nothing changed — skip the reconcile.
      mirror = next;
      // `reconcile` walks the tree and writes only differing leaves, so a
      // token delta touches one string and leaves sibling items untouched.
      setThreads(reconcile(next, { key: "id", merge: false }));
    },
    hydrate(next) {
      mirror = next;
      setThreads(reconcile(next, { key: "id", merge: false }));
    },
    thread: (id) => threads[id],
  };
}

/** Approvals live outside the transcript: they are UI state, not thread state. */
export function createApprovalQueue() {
  const [pending, setPending] = createSignal<ApprovalRequest[]>([]);

  return {
    pending,
    add(request: ApprovalRequest): void {
      setPending((current) =>
        current.some((entry) => entry.approvalId === request.approvalId)
          ? current
          : [...current, request],
      );
    },
    /** Remove by approvalId — the identifier stable across both id spaces. */
    remove(approvalId: string): void {
      setPending((current) => current.filter((entry) => entry.approvalId !== approvalId));
    },
    clear(): void {
      batch(() => setPending([]));
    },
  };
}
