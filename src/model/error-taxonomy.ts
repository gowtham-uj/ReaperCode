/**
 * Error taxonomy for Reaper model calls.
 * Classifies failures so the retry orchestrator and runtime can make
 * intelligent decisions (retry, fallback, compaction, replan, etc.).
 */

export type ModelErrorKind =
  | "timeout"
  | "transport"
  | "rate_limit"
  | "provider_overloaded"
  | "provider_unavailable"
  | "auth"
  | "context_overflow"
  | "malformed_tool_call"
  | "unknown_tool"
  | "session_expired"
  | "bad_request"
  | "server_error"
  | "unknown";

export interface ClassifiedModelError {
  kind: ModelErrorKind;
  retryable: boolean;
  consumesRetryBudget: boolean;
  suggestsFallback: boolean;
  suggestsCompaction: boolean;
  message: string;
  raw: unknown;
}

export function classifyModelError(error: unknown): ClassifiedModelError {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const status = extractHttpStatus(error, message);

  if (status === 402 || /insufficient balance|insufficient quota|quota is insufficient|account quota|payment required|positive balance|credit(?:s)? exhausted|billing hard limit|no credit|please recharge/.test(normalized)) {
    return {
      kind: "provider_unavailable",
      retryable: false,
      consumesRetryBudget: false,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if ((status === 400 || status === 404) && /model .*not found|no such model|unsupported model|does not support|not available|unknown model|not a valid model/.test(normalized)) {
    return {
      kind: "provider_unavailable",
      retryable: false,
      consumesRetryBudget: false,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status === 408 || normalized.includes("timed out") || normalized.includes("timeout") || normalized.includes("aborted")) {
    return {
      kind: "timeout",
      retryable: true,
      consumesRetryBudget: false,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      consumesRetryBudget: true,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status === 529) {
    return {
      kind: "provider_overloaded",
      retryable: true,
      consumesRetryBudget: true,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      retryable: true,
      consumesRetryBudget: false,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status === 413 || status === 400) {
    if (normalized.includes("max_tokens") || normalized.includes("context length") || normalized.includes("too long")) {
      return {
        kind: "context_overflow",
        retryable: true,
        consumesRetryBudget: false,
        suggestsFallback: false,
        suggestsCompaction: true,
        message,
        raw: error,
    };
    }
    if (/model .*not found|no such model|unsupported model|does not support|not available|unknown model|not a valid model/.test(normalized)) {
      return {
        kind: "provider_unavailable",
        retryable: false,
        consumesRetryBudget: false,
        suggestsFallback: true,
        suggestsCompaction: false,
        message,
        raw: error,
      };
    }
    return {
      kind: "bad_request",
      retryable: false,
      consumesRetryBudget: false,
      suggestsFallback: false,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (status && status >= 500) {
    return {
      kind: "server_error",
      retryable: true,
      consumesRetryBudget: true,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (normalized.includes("econnrefused") || normalized.includes("enotfound") || normalized.includes("etimedout") || normalized.includes("network") || normalized.includes("fetch failed")) {
    return {
      kind: "transport",
      retryable: true,
      consumesRetryBudget: false,
      suggestsFallback: true,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  if (normalized.includes("session") && normalized.includes("expir")) {
    return {
      kind: "session_expired",
      retryable: true,
      consumesRetryBudget: false,
      suggestsFallback: false,
      suggestsCompaction: false,
      message,
      raw: error,
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    consumesRetryBudget: false,
    suggestsFallback: false,
    suggestsCompaction: false,
    message,
    raw: error,
  };
}

function extractHttpStatus(error: unknown, message: string): number | undefined {
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  const match = message.match(/\b(\d{3})\b/);
  if (match) {
    const code = Number.parseInt(match[1]!, 10);
    if (code >= 400) return code;
  }
  return undefined;
}
