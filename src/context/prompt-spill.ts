/**
 * Keep a large pasted prompt out of the context window without losing it.
 *
 * The failure this fixes is specific and observed. A user pasted 842,845
 * characters (~211K tokens) into a prompt. The text went straight into the
 * conversation, so the first model call was already 226K tokens — 84% of
 * Reaper's 270K soft cap — and the very next `grep_search` result pushed the
 * next call to 432K, 160% of the cap. Compaction fired afterwards, too late: the
 * request that overflowed had already been sent. The agent spent minutes on one
 * turn and the user watched a composer say "working" with no idea why.
 *
 * The fix is the memory-pointer pattern: write the paste to a file in the
 * thread's own workspace and hand the model a preview plus the path. The model
 * reads exactly what it needs with `file_view`, `grep_search`, or `eval`, so
 * nothing is lost and the first call stays small. It is what ChatGPT does when
 * a paste exceeds a few thousand characters — it becomes an attachment rather
 * than inline text.
 *
 * The substitution happens once, where the prompt enters the run, so the live
 * conversation *and* the journal both record the reference rather than the
 * paste. That matters: if the journal kept the full text, resuming the thread
 * would rehydrate it and blow the window again on the next turn.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Chars above which a prompt is spilled rather than sent inline.
 *
 * 20,000 characters is about 5,000 tokens — the same order as ChatGPT's
 * attachment rule, and small enough that a paste of a few paragraphs stays
 * inline where the model can read it directly. Deliberately conservative: the
 * cost of spilling a prompt that would have fit is one extra `file_view` call,
 * and the cost of not spilling one that does not fit is a blown context and a
 * stalled turn.
 */
export const DEFAULT_PROMPT_SPILL_CHARS = 20_000;

/** How much of the paste stays inline as a preview. */
const PREVIEW_CHARS = 2_000;

export interface SpillResult {
  /** The text to put in the conversation: the original, or a reference. */
  text: string;
  /** True when the prompt was written to a file. */
  spilled: boolean;
  /** The file the paste was written to, when spilled. */
  path?: string;
  /** The original length, always. */
  originalChars: number;
}

/**
 * Spill `prompt` to `<workspaceRoot>/.reaper/pastes/` when it is large.
 *
 * Returns the original text unchanged when it is small enough, so callers can
 * use the result unconditionally. A write failure returns the original text
 * rather than throwing: failing to spill must not fail the turn, and the paste
 * still has somewhere to go (inline, as before).
 */
export function spillLargePrompt(input: {
  workspaceRoot: string;
  prompt: string;
  thresholdChars?: number;
}): SpillResult {
  const originalChars = input.prompt.length;
  const threshold = input.thresholdChars ?? DEFAULT_PROMPT_SPILL_CHARS;
  if (originalChars <= threshold) {
    return { text: input.prompt, spilled: false, originalChars };
  }

  /*
   * Under `.reaper/` so it is already gitignored, already writable in the
   * sandbox, and reachable by the model's workspace tools. A paste is runtime
   * state, not a user file, and putting it among the user's own files would
   * make it show up in their diff.
   */
  const dir = path.join(input.workspaceRoot, ".reaper", "pastes");
  const filePath = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, input.prompt, "utf8");
  } catch {
    return { text: input.prompt, spilled: false, originalChars };
  }

  const relative = path.relative(input.workspaceRoot, filePath);
  const preview = input.prompt.slice(0, PREVIEW_CHARS);
  const approxTokens = Math.ceil(originalChars / 4);
  const text = [
    `[The user pasted ${originalChars.toLocaleString("en-US")} characters (~${approxTokens.toLocaleString("en-US")} tokens).`,
    `That is too large to place in the conversation, so it was saved verbatim to \`${relative}\` in the workspace.`,
    `Nothing was removed. Read it with file_view({ path: "${relative}" }), search it with grep_search, or process it with eval.`,
    `Do not ask the user to paste it again — the full text is on disk.`,
    ``,
    `The first ${PREVIEW_CHARS.toLocaleString("en-US")} characters are below as a preview:`,
    ``,
    preview,
    ``,
    `[end of preview — the remaining ${(originalChars - PREVIEW_CHARS).toLocaleString("en-US")} characters are in ${relative}]`,
  ].join("\n");

  return { text, spilled: true, path: relative, originalChars };
}
