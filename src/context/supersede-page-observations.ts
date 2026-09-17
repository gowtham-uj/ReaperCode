/**
 * Drop the page text from browser results that a later result has replaced.
 *
 * The problem this solves is specific and was measured. A `browser_use` result
 * carries the page: the snapshot or compiled view, tens of thousands of
 * characters. It enters the conversation, and from then on it is re-sent on
 * *every* later model call until something compacts it. On a real mission one
 * page's output ran to 262,631 characters, and the model paid for it many times
 * over.
 *
 * Time-based microcompaction already exists and clears old tool results
 * wholesale, but it is deliberately conservative (five minutes, keeping the last
 * five) and it blanks the result to a placeholder. That loses the audit trail and
 * it is often too late: a mission moving fast has many browser results inside the
 * window, and the expensive ones are exactly the page dumps.
 *
 * This is narrower and earlier. When a newer browser result exists for the same
 * thread, an older one keeps its *facts* — the OUTCOME, the revision, the URL, the
 * lines that changed — and loses its *page*. The page is the part a later read
 * has superseded, and keeping it is keeping a photograph of somewhere the model
 * has already left.
 *
 * What is deliberately preserved:
 *
 *   - the outcome line and the revision, so the model can still see what it did
 *     and in what order;
 *   - the changed lines, because that is the record of what an action *did*;
 *   - anything short. A result under the threshold is not worth touching, and a
 *     conservative pass is one that cannot make things worse.
 */

/** Marks a browser result whose page text was dropped. */
export const SUPERSEDED_PLACEHOLDER = "[page text dropped: a later browser result superseded it]";

export interface SupersedeOptions {
  /** Keep the page text on the most recent N browser results. Default 2. */
  keepRecent?: number;
  /**
   * Only touch results whose page text is at least this long.
   *
   * A long threshold, because the cost of this pass being wrong is losing text a
   * model might have wanted, and the benefit only exists for the big ones. The
   * expensive results are tens of thousands of characters, not hundreds.
   */
  minPageChars?: number;
  /** Which tool produced the results to consider. */
  toolName?: string;
}

export interface SupersedeResult {
  /** Results whose page text was replaced. */
  superseded: number;
  /** Characters removed from the conversation. */
  savedChars: number;
}

const DEFAULT_KEEP_RECENT = 2;
const DEFAULT_MIN_PAGE_CHARS = 4_000;

/**
 * Where the page text starts inside a browser result.
 *
 * Browser results are a small JSON envelope whose `output` is the text the model
 * reads, and the page is appended to that text after the receipt. The markers are
 * the ones the tool writes: `PAGE:` from a program's result and the snapshot
 * header from a look. The earliest marker wins, because both can appear.
 */
const PAGE_MARKERS: string[] = ["\n\nPAGE:", "\nSNAPSHOT:", "compiled perception engine is being rebuilt"];

/** True when a string looks like a browser result with page text in it. */
function pageStartIndex(output: string): number {
  let earliest = -1;
  for (const marker of PAGE_MARKERS) {
    const at = output.indexOf(marker);
    if (at === -1) continue;
    if (earliest === -1 || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * Replace superseded page text with a placeholder. Mutates `messages` in place.
 *
 * Idempotent: a message already superseded is skipped, so running the pass twice
 * costs nothing and does not double-count the saving.
 */
export function supersedePageObservations(
  messages: Array<Record<string, unknown>>,
  options: SupersedeOptions = {},
): SupersedeResult {
  const keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT;
  const minPageChars = options.minPageChars ?? DEFAULT_MIN_PAGE_CHARS;
  const toolName = options.toolName ?? "browser_use";

  // The indices of browser results, newest last.
  const browserResults: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== "tool") continue;
    if (message.name !== toolName && message.tool_name !== toolName) continue;
    browserResults.push(i);
  }
  const eligible = browserResults.slice(0, Math.max(0, browserResults.length - keepRecent));

  let superseded = 0;
  let savedChars = 0;
  for (const index of eligible) {
    const message = messages[index]!;
    if (message.__page_superseded === true) continue;
    const content = typeof message.content === "string" ? message.content : undefined;
    if (content === undefined) continue;
    /*
     * The envelope is JSON: `{"output": "...", "outcome": "...", "rev": N}`. The
     * page lives inside `output`, so the trim happens there and the facts around
     * it are left alone. A result that is not JSON is skipped rather than guessed
     * at, because the failure mode of a wrong guess is corrupting the record.
     */
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }
    const output = typeof envelope["output"] === "string" ? (envelope["output"] as string) : undefined;
    if (output === undefined) continue;

    const at = pageStartIndex(output);
    if (at === -1) continue;
    const pageText = output.slice(at);
    if (pageText.length < minPageChars) continue;

    const kept = output.slice(0, at);
    envelope["output"] = `${kept}\n${SUPERSEDED_PLACEHOLDER}`;
    // The surface is the structured copy of the same page, so it goes too: two
    // copies of a superseded page is double the waste this pass exists to remove.
    delete envelope["surface"];
    message.content = JSON.stringify(envelope);
    message.__page_superseded = true;
    message.__page_superseded_saved = pageText.length;
    superseded += 1;
    savedChars += pageText.length;
  }

  return { superseded, savedChars };
}
