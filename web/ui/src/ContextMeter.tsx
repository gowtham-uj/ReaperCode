import type { TokenUsage } from "@reaper/web-shared";

/**
 * Context pressure, in the shape the reference agents use.
 *
 * The design follows Goose rather than OpenCode, deliberately:
 *
 *  - Goose's thresholds are `<50%` green, `50-85%` yellow, `>85%` red. They
 *    line up with Reaper's own compaction trigger at the soft cap, so the
 *    colour change means "compaction is close" rather than being decorative.
 *  - Goose puts the percentage *first*, as the primary number. It is the
 *    quantity a reader is asking about; "84K / 200K" is the supporting detail.
 *  - Goose shows the counts on hover, which keeps the resting state small
 *    enough for a composer row.
 *
 * What is *not* taken from OpenCode is its accounting. It sums input, output,
 * reasoning, and cache reads and divides by the context limit, which is a
 * measure of tokens billed rather than of prompt occupancy, and is why its
 * meter has been reported reading over 100%. `contextUsage` on the server does
 * the sum that means something and clamps the result; this component only
 * renders it.
 */

const WARNING_PERCENT = 50;
const ERROR_PERCENT = 85;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatExact(value: number): string {
  return value.toLocaleString("en-US");
}

function levelFor(percent: number | null): "ok" | "warning" | "error" | "unknown" {
  if (percent === null) return "unknown";
  if (percent >= ERROR_PERCENT) return "error";
  if (percent >= WARNING_PERCENT) return "warning";
  return "ok";
}

export function ContextMeter({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) return null;

  const pressure = usage.contextUsage;
  /*
   * No `contextUsage` means this payload predates it, or the server could not
   * resolve a limit. Either way the meter must not invent a denominator: it
   * falls back to showing the raw count with no percentage, which is a true
   * statement, rather than a fraction against a window nobody can name.
   */
  const percent = pressure?.percent ?? null;
  const level = levelFor(percent);
  const promptTokens = pressure?.promptTokens ?? usage.last.inputTokens;

  /*
   * The tooltip carries the arithmetic. Hover is where a reader who wants to
   * check the number goes, and the counts are exact there because a tooltip
   * has room for them in a way the composer row does not.
   */
  const details: string[] = [];
  if (pressure && pressure.contextLimit !== null) {
    details.push(`${formatExact(promptTokens)} / ${formatExact(pressure.contextLimit)} tokens`);
    if (pressure.reservedOutputTokens > 0) {
      details.push(`${formatExact(pressure.reservedOutputTokens)} reserved for output`);
    }
    if (pressure.remaining !== null) details.push(`${formatExact(pressure.remaining)} remaining`);
  } else {
    details.push(`${formatExact(promptTokens)} tokens in the last request`);
  }
  if (pressure?.model) details.push(pressure.model);
  if (pressure?.estimated) details.push("estimated");
  if (typeof usage.modelContextWindow === "number" && pressure?.contextLimit != null && pressure.contextLimit !== usage.modelContextWindow) {
    details.push(`model window ${formatExact(usage.modelContextWindow)}`);
  }
  details.push(`${formatTokens(usage.total.totalTokens)} spent this session`);

  // One decimal is kept as-is from the server; the integer case is rendered
  // without a trailing ".0" so the common reading stays short.
  const label = percent === null
    ? formatTokens(promptTokens)
    : `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;

  return (
    <div
      className="context-meter"
      data-level={level}
      title={details.join(" · ")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={percent === null ? `${formatExact(promptTokens)} tokens used, limit unknown` : `${percent}% of the context window used`}
      aria-label={`Context window: ${details.join(", ")}`}
    >
      <div className="context-meter-bar" aria-hidden="true">
        <div
          className="context-meter-fill"
          style={{ width: percent === null ? "0" : percent <= 0 ? "0" : `max(2px, ${percent}%)` }}
        />
      </div>
      {/*
        The percentage is the label, and the counts sit beside it at a size
        that keeps the row quiet. `estimated` is marked with a tilde rather
        than a word: a tokenizer estimate and a provider count are different
        kinds of number, and a reader should be able to tell which they are
        looking at without opening the tooltip.
      */}
      <span className="context-meter-label">
        {percent !== null && pressure?.estimated ? "~" : ""}{label}
      </span>
      {pressure?.contextLimit != null && (
        <span className="context-meter-counts" aria-hidden="true">
          {formatTokens(promptTokens)}/{formatTokens(pressure.contextLimit)}
        </span>
      )}
    </div>
  );
}
