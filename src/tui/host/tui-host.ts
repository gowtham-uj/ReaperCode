/**
 * TUIHost — implements the `SlashHost` interface so that slash
 * commands invoked through the TUI push their output into the
 * message buffer instead of writing to stdout.
 */

import type { SlashHost } from "../../extensions/slash-command-registry.js";
import type { SessionStore } from "../state/session-store.js";

export class TuiHost implements SlashHost {
  constructor(private readonly store: SessionStore) {}

  print(msg: string): void {
    // Multi-line output is split so each line gets a system bubble.
    const lines = msg.split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      this.store.appendSystem(line);
    }
  }

  printError(msg: string): void {
    const lines = msg.split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      this.store.appendError(line);
    }
  }

  /** Confirm via a single-shot blocking prompt on the TUI input
   *  prompt. The full multi-modal prompt UI lands in Phase 5; for
   *  now we auto-deny (the conservative behavior the user must
   *  override with /... flags). */
  async confirm(_msg: string): Promise<boolean> {
    this.store.appendSystem(`[confirm skipped — auto-deny] ${_msg}`);
    return false;
  }

  /** TTY-secret prompts need real echo-off input; out of scope for
   *  this build. */
  async promptSecret(_msg: string): Promise<string | null> {
    this.store.appendError(`[promptSecret not yet implemented in TUI] ${_msg}`);
    return null;
  }
}