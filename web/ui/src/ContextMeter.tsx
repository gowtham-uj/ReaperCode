import type { TokenUsage } from "@reaper/web-shared";

const WARNING_RATIO = 0.70;
const ERROR_RATIO = 0.85;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function ContextMeter({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) return null;
  const cap = typeof usage.contextSoftCap === "number" && usage.contextSoftCap > 0
    ? usage.contextSoftCap
    : undefined;
  const ratio = cap ? Math.min(1, usage.total.totalTokens / cap) : 0;
  const level = ratio >= ERROR_RATIO ? "error" : ratio >= WARNING_RATIO ? "warning" : "ok";
  const parts = [
    `${formatTokens(usage.total.totalTokens)} tokens this session`,
    `last call ${formatTokens(usage.last.totalTokens)}`,
  ];
  if (cap) parts.push(`soft cap ${formatTokens(cap)}`);
  if (typeof usage.modelContextWindow === "number") parts.push(`model window ${formatTokens(usage.modelContextWindow)}`);

  return (
    <div
      className="context-meter"
      data-level={level}
      title={parts.join(" · ")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={cap ?? usage.total.totalTokens}
      aria-valuenow={usage.total.totalTokens}
    >
      <div className="context-meter-bar" aria-hidden="true">
        <div className="context-meter-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
      <span className="context-meter-label">
        {formatTokens(usage.total.totalTokens)}{cap ? ` / ${formatTokens(cap)}` : ""}
      </span>
    </div>
  );
}
