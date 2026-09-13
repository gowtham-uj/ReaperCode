import type { TokenUsage } from "@reaper/web-shared";

const WARNING_RATIO = 0.70;
const ERROR_RATIO = 0.85;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/**
 * How full the model's context window is right now.
 *
 * What this meter shows was wrong in a way that made it useless: it divided the
 * *cumulative* token count for the whole session by the *per-call* soft cap. A
 * session that had made twenty calls read "2.4M / 270k" and sat pinned at 100%,
 * which is not a number a user can act on — 2.4M tokens were never in the
 * window at once, they were paid for one call at a time, and the window was
 * never full. Any session long enough to matter showed a permanently full bar.
 *
 * The right quantity is the size of the *last* request, because that is what has
 * to fit. `usage.last.totalTokens` is that number, and the denominator is the
 * soft cap that request was measured against.
 *
 * The cumulative figure is still worth showing, because it is what a session has
 * cost. It moves to the tooltip and is labelled as a total, so the two numbers
 * can no longer be read as one fraction.
 */
export function ContextMeter({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) return null;

  const cap = typeof usage.contextSoftCap === "number" && usage.contextSoftCap > 0
    ? usage.contextSoftCap
    : undefined;
  /*
   * `last.totalTokens` is the provider's input count plus the output it
   * generated, so it can exceed the cap slightly on a call that ran right up to
   * it. Clamped, because a bar that can read 103% is a bar that looks broken.
   */
  const used = Math.min(usage.last.totalTokens, cap ?? usage.last.totalTokens);
  const ratio = cap ? Math.min(1, used / cap) : 0;
  const level = ratio >= ERROR_RATIO ? "error" : ratio >= WARNING_RATIO ? "warning" : "ok";

  const parts = cap
    ? [`${formatTokens(used)} of ${formatTokens(cap)} tokens in the last request`]
    : [`${formatTokens(used)} tokens in the last request`];
  if (typeof usage.modelContextWindow === "number") {
    parts.push(`model window ${formatTokens(usage.modelContextWindow)}`);
  }
  // The session total, named as a total so it is never read as the numerator.
  parts.push(`${formatTokens(usage.total.totalTokens)} tokens spent this session`);

  return (
    <div
      className="context-meter"
      data-level={level}
      title={parts.join(" · ")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={cap ?? used}
      aria-valuenow={used}
      aria-label={`Context window: ${parts.join(", ")}`}
    >
      <div className="context-meter-bar" aria-hidden="true">
        <div className="context-meter-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
      <span className="context-meter-label">
        {formatTokens(used)}{cap ? ` / ${formatTokens(cap)}` : ""}
      </span>
    </div>
  );
}
