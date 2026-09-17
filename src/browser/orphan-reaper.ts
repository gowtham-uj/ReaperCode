/**
 * Closing pages no thread owns.
 *
 * ## The problem this exists for
 *
 * Steel's Chrome is one long-lived process shared by every thread, and it
 * persists its session profile on disk. So pages accumulate from three sources,
 * and none of them is anybody's fault:
 *
 *   1. a thread is deleted while its pages are open, and the pages stay;
 *   2. the app-server crashes or is restarted, so no runtime is left to close
 *      anything;
 *   3. a page the *site* opened (`window.open`, a `target=_blank` link) whose
 *      opener has since gone.
 *
 * Measured, this is not a slow leak but a hard failure. A mission run left
 * twenty-six pages across thirty-eight targets, and `connectOverCDP` then could
 * not complete its handshake inside thirty seconds: every attach enumerates
 * every target in the browser, so the cost of attaching grows with the mess
 * until attaching stops working. A browser that cannot be attached to is the one
 * failure this whole design exists to prevent.
 *
 * ## What an orphan is
 *
 * A page whose CDP target id appears in no thread's ownership record. That is
 * the only definition available that is safe: a page belonging to a thread that
 * has not been resumed yet still has its id on disk, so it is not an orphan and
 * is left alone. A page that no record names cannot be reached by any thread
 * through the API, so closing it cannot lose work.
 *
 * ## Why not a timeout
 *
 * The tempting rule is "close pages idle for an hour", and it is wrong: a
 * half-completed job application legitimately sits untouched for longer than
 * that, and closing it would throw away exactly the state the browser is kept
 * alive to hold. Ownership is the correct test because it says whether the page
 * can still be *reached*, which is a different and much safer question than
 * whether it has been used recently.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";

/** Where a thread's ownership records live, under the workspace root. */
const BROWSER_STATE_DIR = join(".reaper", "browser");

/**
 * Every target id any thread has recorded, from the state directory.
 *
 * Read from disk rather than from the live registry on purpose. The registry is
 * process-local and empty after a restart, which is precisely the case that
 * leaves orphans; the files are the durable record of who owns what.
 *
 * A file that cannot be read is skipped rather than failing the pass. A single
 * corrupt record must not stop the reaper from clearing everything else, and a
 * thread whose record is unreadable is one whose pages will be closed as
 * orphans, which is the same outcome as the record never having existed.
 */
export async function readOwnedTargetIds(workspaceRoot: string): Promise<Set<string>> {
  const owned = new Set<string>();
  const dir = join(workspaceRoot, BROWSER_STATE_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".pages-owner.json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as { targetIds?: unknown };
      if (Array.isArray(parsed.targetIds)) {
        for (const id of parsed.targetIds) if (typeof id === "string") owned.add(id);
      }
    } catch {
      /* An unreadable record owns nothing, which is how it is treated. */
    }
  }
  return owned;
}

export interface OrphanSweepResult {
  /** Pages that were open when the sweep ran. */
  examined: number;
  /** Pages closed because no thread's record named them. */
  closed: number;
  /** Pages left alone, because a thread owns them. */
  kept: number;
  /** Target ids that were closed, for logging. */
  closedIds: string[];
  /** Non-fatal problems, so a caller can tell "nothing to do" from "could not look". */
  errors: string[];
}

/**
 * Close every page in the browser that no thread owns.
 *
 * Takes a `Browser` rather than connecting itself, so the caller decides when
 * the cost of attaching is paid and whether it is paid at all. This is called on
 * a timer and after a delete, and on a browser that is too clogged to attach to
 * it cannot run at all: which is why the *first* sweep after a bad run may need
 * a manual restart, and every sweep after it keeps the browser from getting
 * there.
 */
export async function sweepOrphanPages(
  browser: Browser,
  owned: ReadonlySet<string>,
  options: { keepAtLeast?: number } = {},
): Promise<OrphanSweepResult> {
  const result: OrphanSweepResult = { examined: 0, closed: 0, kept: 0, closedIds: [], errors: [] };
  const context = browser.contexts()[0];
  if (context === undefined) return result;

  const pages = context.pages().filter((page) => !page.isClosed());
  result.examined = pages.length;

  /*
   * A browser with no tickets at all is not swept.
   *
   * The ownership files can be missing for a reason that has nothing to do with
   * orphans: a fresh install, a workspace that moved, a state directory that was
   * cleared. Closing every page in that situation would throw away work to solve
   * a problem that does not exist. The sweep needs evidence of at least one
   * owner before it trusts "nobody owns this" as an answer.
   */
  if (owned.size === 0) {
    result.kept = pages.length;
    result.errors.push("no ownership records found; leaving every page alone");
    return result;
  }

  /*
   * The last page is never closed by a sweep.
   *
   * Steel's model is a browser with a context in it, and a context with no pages
   * is a state its viewer does not render: the pane shows nothing and the next
   * attach has no page to adopt, which looks like a broken browser rather than
   * an empty one. Keeping one page costs nothing and avoids manufacturing that
   * state.
   */
  const keepAtLeast = options.keepAtLeast ?? 1;

  for (const page of pages) {
    if (result.examined - result.closed <= keepAtLeast) {
      result.kept += 1;
      continue;
    }
    let id: string | undefined;
    try {
      const session = await context.newCDPSession(page);
      const info = await session.send("Target.getTargetInfo").catch(() => undefined);
      await session.detach().catch(() => undefined);
      id = (info as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo?.targetId;
    } catch (error) {
      /*
       * A page whose id cannot be read is not treated as an orphan. Closing
       * something unidentified is the one mistake this could make that loses
       * work, and "cannot tell" is not "nobody owns it".
       */
      result.errors.push(`could not identify a page: ${(error as Error).message}`);
      result.kept += 1;
      continue;
    }
    if (id === undefined || owned.has(id)) {
      result.kept += 1;
      continue;
    }
    await page.close().catch(() => undefined);
    result.closed += 1;
    result.closedIds.push(id);
  }
  return result;
}
