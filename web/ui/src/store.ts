import { useSyncExternalStore } from "react";

import {
  applyNotification,
  emptyThreads,
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
