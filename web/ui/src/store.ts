import { useSyncExternalStore } from "react";

import {
  applyNotification,
  emptyThreads,
  replaceTurns,
  seedThread,
  type AppThread,
  type ThreadsState,
} from "@reaper/web-shared";

type Listener = () => void;
type Schedule = (flush: () => void) => void;

/**
 * React-facing external store for the framework-neutral notification reducer.
 *
 * The reducer folds every message synchronously so reconnect cursors and
 * backfill always see the latest state. React subscribers are notified at most
 * once per animation frame: token streams can arrive hundreds of times per
 * second, and rendering every WebSocket frame would make React the bottleneck.
 */
export interface TranscriptStore {
  ingest(method: string, params: Record<string, unknown>): void;
  hydrate(next: ThreadsState): void;
  seedThread(raw: Record<string, unknown>): void;
  /**
   * Replace a thread's turns with the authoritative page from a resume.
   *
   * Distinct from `seedThread`, which merges the reply's metadata and leaves the
   * turn list alone. The resume carries both, and for a long time only the
   * metadata half was read: `initialTurnsPage` arrived, was typed, and was
   * dropped, so the transcript rendered whatever the replay stream delivered. A
   * 101-turn mission showed four turns in the UI.
   */
  replaceTurns(threadId: string, turns: Array<Record<string, unknown>>): void;
  snapshot(): ThreadsState;
  getSnapshot(): ThreadsState;
  subscribe(listener: Listener): () => void;
  thread(id: string): AppThread | undefined;
}

export function createTranscriptStore(
  initial: ThreadsState = emptyThreads(),
  schedule: Schedule = defaultSchedule,
): TranscriptStore {
  let current = initial;
  let notificationScheduled = false;
  const listeners = new Set<Listener>();

  const publish = (): void => {
    if (notificationScheduled) return;
    notificationScheduled = true;
    schedule(() => {
      notificationScheduled = false;
      for (const listener of [...listeners]) listener();
    });
  };

  return {
    ingest(method, params) {
      const next = applyNotification(current, method, params);
      if (next === current) return;
      current = next;
      publish();
    },
    hydrate(next) {
      if (next === current) return;
      current = next;
      publish();
    },
    // `thread/start` and `thread/resume` both reply with the full thread, which
    // is the only place the app learns a thread's model until the next
    // `thread/model/updated` notification. Folding it in needs `mergeThread`
    // rather than `ingest`: the notification path looks up a `params.threadId`,
    // and a reply nests the thread under `thread` with its id inside.
    seedThread(raw) {
      const next = seedThread(current, raw);
      if (next === current) return;
      current = next;
      publish();
    },
    replaceTurns(threadId, turns) {
      /*
       * The server's page is authoritative, so this replaces rather than merges.
       *
       * A merge would be wrong in the direction that matters: a turn the server
       * no longer has — from a thread that was compacted, or a replay the client
       * built from stale events — would survive as a ghost. The page is what the
       * thread is.
       */
      const next = replaceTurns(current, threadId, turns);
      if (next === current) return;
      current = next;
      publish();
    },
    snapshot: () => current,
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    thread: (id) => current[id],
  };
}

export function useTranscriptState(store: TranscriptStore): ThreadsState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function defaultSchedule(flush: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => flush());
    return;
  }
  queueMicrotask(flush);
}
