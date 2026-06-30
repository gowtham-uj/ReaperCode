/**
 * useInputKeys — global keybinds that aren't tied to the input
 * prompt. App.tsx owns the double-Ctrl-C exit and the help / reverse-
 * search popover toggles; this hook groups the "view preference"
 * keybinds so a future contributor can scan one file for the full
 * list of `Ctrl+<letter>` shortcuts.
 *
 * Conventions:
 *   - Ctrl+T  → toggle the hideThinkingBlock preference (less-noisy
 *               baseline is hidden). Persists via SessionStore.
 *   - Ctrl+E  → toggle the toolCardsDefaultExpanded preference.
 *               Affects new tool cards only; existing cards keep
 *               their own expansion state.
 *
 * All hooks are fail-open: a thrown handler in a downstream store
 * call is swallowed so the TUI stays responsive.
 */

import { useInput } from "ink";

import type { SessionStore } from "../state/session-store.js";

export interface UseInputKeysOptions {
  store: SessionStore;
  /** Set to false to disable (e.g. when a popover is open and the
   *  popover owns the keybinds). */
  isActive?: boolean;
}

export function useInputKeys(opts: UseInputKeysOptions): void {
  const { store, isActive = true } = opts;

  useInput((input, key) => {
    if (!key.ctrl) return;
    // Ctrl+T → toggle thinking-block visibility.
    if (input === "t") {
      try { store.toggleThinkingBlock(); } catch { /* fail-open */ }
      return;
    }
    // Ctrl+E → toggle the default tool-card expansion preference.
    // Implemented inline because the store exposes a getter but not
    // a setter — the toggle is a single-line flip.
    if (input === "e") {
      try {
        const next = !store.isToolCardsDefaultExpanded();
        // We don't have a setter method on the store, so we use the
        // private path by going through the expand/collapse methods
        // is not applicable. Instead, we update the viewPrefs via a
        // dedicated toggle method on the store (see below).
        store.toggleToolCardsDefaultExpanded(next);
      } catch { /* fail-open */ }
      return;
    }
  }, { isActive });
}
