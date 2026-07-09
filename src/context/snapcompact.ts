/**
 * context/snapcompact.ts — T4 OMP port: image-cluster-aware compaction.
 *
 * OMP's snapcompact collapses consecutive image blocks into a single
 * summary stub when the live conversation has multiple `image`-typed
 * content blocks back-to-back. Reaper treats images as opaque text
 * (no media channels), so this layer is a no-op for non-image
 * conversations.
 *
 * For Reaper's wiring, the snapcompact hook:
 * 1. Counts image blocks in the live conversation (messages with a
 *    content array containing image_url or image type parts).
 * 2. If there are ≥ 3 image blocks AND they're consecutive (no
 *    non-image message between them), collapses them into one
 *    synthetic summary stub message.
 * 3. Otherwise inert — no-op return.
 *
 * Wire path: when `cm.snapcompactEnabled === true` AND image-cluster
 * condition fires, the wiring mutates `working` in place (in
 * `onBeforeModelCall`). OMP equivalent: the strategy in
 * `runAutoCompaction("snapcompact", ...)`.
 */
export interface SnapcompactResult {
  /** Whether snapcompact fired. */
  performed: boolean;
  /** Number of image blocks collapsed. */
  collapsedImages: number;
  /** Chars saved. */
  savedChars: number;
}

export interface SnapcompactOptions {
  /** Minimum number of image blocks to trigger (OMP uses 3). */
  minConsecutiveImages?: number;
}

/**
 * Count image blocks in the live conversation. Reaper uses a simple
 * heuristic: a message with a `content` array containing at least one
 * `image_url` or `type === "image"` part counts as an image block.
 */
export function countImageBlocks(messages: unknown[]): number {
  let count = 0;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const content = rec.content;
    if (!Array.isArray(content)) continue;
    let hasImage = false;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type === "image" || p.type === "image_url" || p.image_url !== undefined) {
        hasImage = true;
        break;
      }
    }
    if (hasImage) count += 1;
  }
  return count;
}

/**
 * Detect consecutive image blocks. Two image blocks are "consecutive"
 * if no non-image message appears between them. OMP uses the same
 * definition.
 */
export function findConsecutiveImageRuns(messages: unknown[]): Array<{
  startIdx: number;
  endIdx: number;
}> {
  const runs: Array<{ startIdx: number; endIdx: number }> = [];
  let runStart = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i] as Record<string, unknown> | null;
    const content = m && m.content;
    let isImage = false;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (p.type === "image" || p.type === "image_url" || p.image_url !== undefined) {
            isImage = true;
            break;
          }
        }
      }
    }
    if (isImage) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        runs.push({ startIdx: runStart, endIdx: i - 1 });
        runStart = -1;
      }
    }
  }
  if (runStart !== -1) {
    runs.push({ startIdx: runStart, endIdx: messages.length - 1 });
  }
  return runs;
}

/**
 * Run snapcompact on the live conversation. Mutates `working` in
 * place by collapsing each consecutive image run into a single
 * synthetic stub message. OMP equivalent:
 * `pruneSnapcompact(entries, opts)` in `compaction/snapcompact.ts`.
 *
 * Returns `{ performed: false }` if no runs qualify (or images are
 * not present in this conversation).
 */
export function maybeSnapcompact(
  working: unknown[],
  options: SnapcompactOptions = {},
): SnapcompactResult {
  const minConsecutive = options.minConsecutiveImages ?? 3;
  const runs = findConsecutiveImageRuns(working);
  if (runs.length === 0) {
    return { performed: false, collapsedImages: 0, savedChars: 0 };
  }
  let collapsed = 0;
  let savedChars = 0;
  // Process runs from end to start so indices stay valid as we mutate.
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    const run = runs[r]!;
    if (run.endIdx - run.startIdx + 1 < minConsecutive) continue;
    // Replace the run with a single synthetic stub message.
    const stub = {
      role: "user",
      content: `[snapcompact] ${run.endIdx - run.startIdx + 1} image blocks collapsed (range ${run.startIdx}..${run.endIdx}); see persisted artifacts for the originals.`,
      __snapcompacted: true,
    };
    // Compute the saved chars: sum of the content lengths of the collapsed
    // messages minus the stub length.
    let originalChars = 0;
    for (let i = run.startIdx; i <= run.endIdx; i += 1) {
      const m = working[i] as Record<string, unknown> | null;
      const content = m?.content;
      if (typeof content === "string") originalChars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "string") originalChars += part.length;
          else if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            const text = p.text;
            if (typeof text === "string") originalChars += text.length;
          }
        }
      }
    }
    const stubLen = typeof stub.content === "string" ? stub.content.length : 0;
    savedChars += Math.max(0, originalChars - stubLen);
    collapsed += run.endIdx - run.startIdx;
    // Splice: remove [startIdx+1..endIdx] and replace startIdx with the stub.
    working.splice(run.startIdx, run.endIdx - run.startIdx + 1, stub);
  }
  if (collapsed === 0) {
    return { performed: false, collapsedImages: 0, savedChars: 0 };
  }
  return { performed: true, collapsedImages: collapsed, savedChars };
}