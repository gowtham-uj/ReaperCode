/**
 * One context-management technique, as a transcript row.
 *
 * Reaper shrinks a conversation several ways, and they are not interchangeable.
 * Dropping a stale `grep` result and rewriting the whole conversation with a
 * model call can free a similar number of tokens while meaning very different
 * things about what the agent still knows. A single "Compacted context" row —
 * which is what this replaces — could not say which had happened, or whether
 * the agent had lost anything, so a long session looked like it was quietly
 * forgetting things with no way to check.
 *
 * The row answers four questions in order of how much a reader wants them:
 * which technique ran, how much it reclaimed, whether it is still running, and
 * what the context looks like now. Everything else is detail behind the
 * disclosure, because a session that compacts every few minutes should not
 * fill the transcript with paragraphs about compaction.
 */
import { memo, useEffect, useState } from "react";
import { contextTechniqueLabel, summarizeContextRun, type AppThreadItem } from "@reaper/web-shared";

type ContextItem = Extract<AppThreadItem, { type: "contextManagement" }>;

/**
 * Techniques worth opening by default.
 *
 * Only the ones that can lose information, and only when they actually did
 * something. A rewrite by a model is the one a user might want to audit; a
 * prune of aged output is routine and should stay collapsed. Opening every row
 * would make the transcript read as a compaction log with a conversation
 * buried in it.
 */
const EXPANDABLE: ReadonlySet<string> = new Set([
  "full_summary",
  "handoff_summary",
  "idle_compaction",
  "incomplete_recovery",
  "ptl_recovery",
]);

/**
 * The saving, in the same units the CLI and the detail line use.
 *
 * One decimal only below 100 so the badge stays narrow, and no unit suffix
 * beyond the letter: the badge sits inline with the label, and "−1.0MB" next to
 * "saved 1.0MB" was the same number stated twice in two different alphabets.
 * The suffix is carried once, by the fuller sentence, and the badge is the
 * compact form of the same figure.
 */
function formatChars(chars: number): string {
  if (chars >= 1_000_000) {
    const millions = chars / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : millions.toFixed(1)}MB`;
  }
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}k`;
  return String(chars);
}

/** Seconds a running technique has been going, re-rendered once a second. */
function useElapsed(startedAt: number | undefined, running: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || startedAt === undefined) return;
    /*
     * Ticking only while running. A finished row's duration never changes, so
     * an interval left behind would re-render a transcript that is already at
     * rest — the exact cost the streaming work went to some trouble to avoid.
     */
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  if (startedAt === undefined) return undefined;
  return Math.max(0, now - startedAt);
}

export const ContextView = memo(function ContextView({ item }: { item: ContextItem }) {
  const running = item.status === "inProgress";
  const failed = item.status === "failed";
  const elapsed = useElapsed(item.startedAt, running);
  /*
   * The detail line says *what* happened; the badge says how much.
   *
   * `summarizeContextRun` produces both, which is right for the CLI where there
   * is no badge to carry a number, and wrong here where it printed the same
   * figure twice in two units: "−1.0M" beside "saved 1.0MB". The saving is
   * already on screen, so it is removed from the sentence and only the
   * description survives.
   */
  const savingShown = item.savedChars !== undefined && item.savedChars > 0;
  // Built by omission rather than by setting the fields to `undefined`, which
  // `exactOptionalPropertyTypes` rejects and which would also mean the helper
  // has to distinguish "absent" from "explicitly nothing".
  const detail = summarizeContextRun({
    ...(item.messagesBefore !== undefined ? { messagesBefore: item.messagesBefore } : {}),
    ...(item.messagesAfter !== undefined ? { messagesAfter: item.messagesAfter } : {}),
    ...(!savingShown && item.savedChars !== undefined ? { savedChars: item.savedChars } : {}),
    ...(!savingShown && item.savedTokens !== undefined ? { savedTokens: item.savedTokens } : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
  });
  const expandable = EXPANDABLE.has(item.technique) && !running;

  /*
   * Collapsed on mount and left alone afterwards.
   *
   * There is no auto-open here, unlike the Code Mode block: that block is the
   * product of the action that just ran, while this row reports housekeeping
   * the user did not ask for. Opening it unbidden would push the answer they
   * are waiting for further down the screen.
   */
  const [open, setOpen] = useState(false);

  return (
    <div className="context-row" data-status={item.status} data-technique={item.technique}>
      <div className="context-head">
        <span className={running ? "context-dot context-dot-live" : "context-dot"} aria-hidden="true" />
        <span className="context-label">{contextTechniqueLabel(item.technique)}</span>

        {savingShown && (
          <span className="context-saved" title={`${item.savedChars!.toLocaleString()} characters removed`}>
            −{formatChars(item.savedChars!)}
          </span>
        )}

        {running && (
          <span className="context-time" aria-live="polite">
            {elapsed !== undefined ? `${(elapsed / 1000).toFixed(1)}s` : "running"}
          </span>
        )}

        {failed && <span className="context-failed">failed</span>}

        {expandable && (
          <button
            type="button"
            className="context-toggle"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide" : "Details"}
          </button>
        )}
      </div>

      {detail && <div className="context-detail">{detail}</div>}

      {open && <ContextFacts item={item} />}
    </div>
  );
});

function ContextFacts({ item }: { item: ContextItem }) {
  const facts: Array<[string, string]> = [];
  if (item.messagesBefore !== undefined && item.messagesAfter !== undefined) {
    facts.push(["Messages", `${item.messagesBefore} → ${item.messagesAfter}`]);
  }
  if (item.savedTokens !== undefined && item.savedTokens > 0) {
    facts.push(["Tokens reclaimed", item.savedTokens.toLocaleString()]);
  }
  if (item.usedTokens !== undefined && item.usedTokens > 0) {
    facts.push(["Context then", item.usedTokens.toLocaleString()]);
  }
  if (item.softCap !== undefined && item.softCap > 0) {
    facts.push(["Reaper's budget", item.softCap.toLocaleString()]);
  }
  if (facts.length === 0) return null;
  return (
    <dl className="context-facts">
      {facts.map(([label, value]) => (
        <div className="context-fact" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
