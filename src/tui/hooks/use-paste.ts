/**
 * use-paste — terminal bracketed-paste parser-state machine.
 *
 * Terminals emit ESC[200~ before a pasted block and ESC[201~ after.
 * During the block, the data is delivered as a single stdin "data"
 * event (raw mode keeps each chunk separate, so we accumulate). When
 * the closing sentinel arrives we emit the full pasted string via
 * the callback.
 *
 * Why a state machine: Ink's `useInput` fires one event per
 * logical keypress; the bracketed block arrives in N raw "data"
 * events. We listen on the raw stream and reconstruct the block.
 *
 * Usage:
 *   useEffect(() => {
 *     return usePaste((text) => onPaste(text));
 *   }, [onPaste]);
 */

import { useEffect } from "react";

const PASTE_BEGIN = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function usePaste(onPaste: (text: string) => void): void {
  useEffect(() => {
    // We can't subscribe to Ink's stdin directly without bypassing
    // Ink's input pipeline. Instead, listen on process.stdin data
    // events when raw mode is enabled. This hook is a no-op if
    // stdin isn't a TTY.
    if (!process.stdin || !process.stdin.isTTY) return;

    let buffer = "";
    let inPaste = false;
    const onData = (chunk: Buffer | string): void => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let rest = str;
      while (rest.length > 0) {
        if (!inPaste) {
          const beginIdx = rest.indexOf(PASTE_BEGIN);
          if (beginIdx < 0) {
            // No paste sentinel — drop the chunk (Ink's useInput
            // already handles per-character keys).
            return;
          }
          rest = rest.slice(beginIdx + PASTE_BEGIN.length);
          inPaste = true;
        }
        // Inside paste: accumulate until we see the end sentinel.
        const endIdx = rest.indexOf(PASTE_END);
        if (endIdx < 0) {
          buffer += rest;
          return;
        }
        buffer += rest.slice(0, endIdx);
        // Normalize CRLF → LF for cross-platform parity.
        const text = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        buffer = "";
        inPaste = false;
        rest = rest.slice(endIdx + PASTE_END.length);
        // Fire callback (asynchronously so we don't re-enter React
        // state updates from inside a stdin event).
        setImmediate(() => onPaste(text));
      }
    };

    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, [onPaste]);
}