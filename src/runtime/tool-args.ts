/**
 * Engine-level tool argument normalization.
 *
 * The runtime engine in `runtime/engine.ts` delegates the canonical
 * tool-name allowlist and per-tool arg shape to
 * `src/tools/tool-allowlist.ts`. This module is the same surface
 * that the engine's tool-call parser uses — it centralizes:
 *   - `isKnownToolName(name)` — re-exported from the shared allowlist.
 *   - `stripUnknownToolArgs(name, args)` — clone-and-strip helper
 *     used by `normalizeToolCallInput`.
 *
 * Exposing it as a separate module lets the engine's parser stay
 * concise AND lets the test suite call the same functions the
 * parser calls, so a "view_file drift" regression is caught here,
 * not in a coupled engine test.
 *
 * This module intentionally lives under `src/runtime/` (not
 * `src/tools/`) because it is consumed by the runtime, not by the
 * tool implementations themselves.
 */

import { getAllowedArgs, isKnownToolName, KNOWN_TOOLS } from "../tools/tool-allowlist.js";

export { getAllowedArgs, isKnownToolName, KNOWN_TOOLS };

export type StripResult =
  | { cleaned: Record<string, unknown>; stripped: string[] }
  | { error: "unknown_tool" };

/**
 * Clone `args` and remove any keys not in the tool's allowed-args
 * list. Returns `{ cleaned, stripped }` when the tool is known;
 * `{ error: "unknown_tool" }` when it is not. The input object is
 * never mutated.
 */
export function stripUnknownToolArgs(name: string, args: Record<string, unknown>): StripResult {
  const allowed = getAllowedArgs(name);
  if (allowed.length === 0 && !isKnownToolName(name)) {
    return { error: "unknown_tool" };
  }
  const allowedSet = new Set(allowed);
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(args);
  } catch {
    cloned = { ...args };
  }
  const stripped: string[] = [];
  for (const key of Object.keys(cloned)) {
    if (!allowedSet.has(key)) {
      stripped.push(key);
      delete cloned[key];
    }
  }
  return { cleaned: cloned, stripped };
}
