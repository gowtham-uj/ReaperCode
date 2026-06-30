import type { ArtifactStore } from "../../artifacts/store.js";

/**
 * Retrieve a previously-stored artifact (e.g. spillovered tool output) by
 * `artifactId`. The Codex/Claude-style API supports:
 *
 * - `startLine` / `endLine` — 1-indexed inclusive line window
 * - `pattern` — regex; returns only matching lines with line numbers
 * - `jsonPath` — dot/bracket path; returns the JSON fragment at that path
 * - `maxBytes` — byte cap on the returned content (default 50KB)
 */
export async function getToolOutputTool(
  store: ArtifactStore,
  args: {
    artifactId: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
    pattern?: string | undefined;
    jsonPath?: string | undefined;
    maxBytes?: number | undefined;
  },
) {
  return store.read(args.artifactId, {
    startLine: args.startLine,
    endLine: args.endLine,
    pattern: args.pattern,
    jsonPath: args.jsonPath,
    maxBytes: args.maxBytes,
  });
}
