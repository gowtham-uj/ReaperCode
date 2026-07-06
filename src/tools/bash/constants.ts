import { getBashTunables } from "../../config/config-tunables.js";
export const BASH_INPUT_DEFAULTS = {
  DEFAULT_TIMEOUT_MS: Number(getBashTunables().defaultTimeoutMs ?? 60_000),
  DEFAULT_IDLE_TIMEOUT_MS: Number(getBashTunables().idleTimeoutMs ?? 45_000),
  PERSIST_THRESHOLD_CHARS: Number(getBashTunables().persistThresholdChars ?? 30_000),
  PREVIEW_SIZE_CHARS: Number(getBashTunables().previewSizeChars ?? 1_200),
  ASSISTANT_BLOCKING_BUDGET_MS: Number(getBashTunables().assistantBlockingBudgetMs ?? 120_000),
  MAX_OUTPUT_BYTES: Number(getBashTunables().maxOutputBytes ?? 50 * 1024 * 1024),
} as const;
