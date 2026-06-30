/**
 * useSession — React 19 + useSyncExternalStore bridge over the
 * SessionStore. The store itself is framework-agnostic; this hook
 * is the only place that knows about React.
 */

import { useSyncExternalStore } from "react";

import type { SessionStore } from "../state/session-store.js";
import type { TuiSnapshot } from "../types.js";

export function useSession(store: SessionStore): TuiSnapshot {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot(),
    () => store.snapshot(),
  );
}