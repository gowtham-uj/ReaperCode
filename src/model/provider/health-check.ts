/**
 * Provider credential health check.
 *
 * Storing a key told the user nothing about whether it works: `connectApi`
 * writes the credential and then calls `discover`, which returns immediately
 * for any provider without a `discoverModels` hook, so a typo'd key was
 * accepted silently and only failed on the user's first real turn.
 *
 * This module makes one bounded, read-only request against the provider's own
 * model-listing endpoint and reports the outcome. It never returns the
 * credential, and it never includes it in a message — a provider error body is
 * truncated and could otherwise echo the key back.
 */

import type { ProviderAuthSuccess, ProviderDescriptor } from "./types.js";

export type ProviderHealthStatus = "ok" | "invalid_credential" | "unreachable" | "unsupported";

export interface ProviderHealthResult {
  providerId: string;
  status: ProviderHealthStatus;
  /** Safe to show in the UI. Never contains credential material. */
  message: string;
  /** HTTP status from the probe, when a response was received. */
  httpStatus?: number;
  checkedAt: string;
  latencyMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough of an error body to be diagnostic, small enough to stay a message. */
const MAX_BODY_CHARS = 300;

export interface ProviderHealthProbe {
  url: string;
  headers: Record<string, string>;
}

/**
 * Models.dev omits `api` for 26 providers — including openai, anthropic, groq,
 * and deepinfra — because their AI SDK package hard-codes the endpoint. Without
 * these, the most commonly configured providers would all report "cannot be
 * verified", which is the exact silent-pass this check exists to remove. Keyed
 * by npm package so a provider that shares a package inherits the same base.
 */
const PACKAGE_DEFAULT_BASE: Record<string, string> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/cohere": "https://api.cohere.com/v2",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
};

/**
 * Build the probe request for a descriptor. Returns undefined when the
 * provider advertises no base URL (26 of the catalog's providers don't) or
 * speaks a family with no known listing endpoint — those report `unsupported`
 * rather than a fabricated pass.
 */
export function buildHealthProbe(
  descriptor: ProviderDescriptor,
  auth: ProviderAuthSuccess,
  baseUrlOverride?: string,
): ProviderHealthProbe | undefined {
  const packageDefault = descriptor.npm ? PACKAGE_DEFAULT_BASE[descriptor.npm] : undefined;
  const rawBase = (baseUrlOverride ?? descriptor.api ?? descriptor.baseUrl ?? packageDefault ?? "").trim()
    || (packageDefault ?? "");
  if (!rawBase || rawBase.includes("${")) return undefined;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    return undefined;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return undefined;

  const token = auth.type === "api" ? auth.key : auth.access;
  if (!token) return undefined;

  const trimmedPath = base.pathname.replace(/\/+$/, "");
  switch (descriptor.sdkFamily) {
    case "anthropic-messages": {
      const path = trimmedPath.endsWith("/v1") ? `${trimmedPath}/models` : `${trimmedPath}/v1/models`;
      return {
        url: new URL(path, base).toString(),
        headers: { "x-api-key": token, "anthropic-version": "2023-06-01" },
      };
    }
    case "openai-chat":
      return {
        url: new URL(`${trimmedPath}/models`, base).toString(),
        headers: { authorization: `Bearer ${token}` },
      };
    default:
      return undefined;
  }
}

/**
 * Providers echo the offending credential back in error bodies often enough
 * that the truncated detail cannot be trusted verbatim — redact the token and
 * any long secret-shaped run before the text becomes a UI message.
 */
function redact(body: string, token: string): string {
  let text = token ? body.split(token).join("[redacted]") : body;
  text = text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
  return text;
}

function describeFailure(httpStatus: number, body: string, token: string): { status: ProviderHealthStatus; message: string } {
  const detail = redact(body, token).trim().slice(0, MAX_BODY_CHARS);
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      status: "invalid_credential",
      message: `The provider rejected this credential (HTTP ${httpStatus}).${detail ? ` ${detail}` : ""}`,
    };
  }
  if (httpStatus === 404) {
    return {
      status: "unsupported",
      message: `This provider has no model-listing endpoint to verify against (HTTP 404). The credential was saved but not verified.`,
    };
  }
  return {
    status: "unreachable",
    message: `The provider returned HTTP ${httpStatus}.${detail ? ` ${detail}` : ""}`,
  };
}

export async function checkProviderCredential(input: {
  descriptor: ProviderDescriptor;
  auth: ProviderAuthSuccess;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ProviderHealthResult> {
  const checkedAt = new Date().toISOString();
  const providerId = input.descriptor.id;
  const probe = buildHealthProbe(input.descriptor, input.auth, input.baseUrl);
  if (!probe) {
    return {
      providerId,
      status: "unsupported",
      message: "This provider does not expose an endpoint Reaper can verify a credential against. It was saved without verification.",
      checkedAt,
    };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await doFetch(probe.url, {
      method: "GET",
      headers: probe.headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (response.ok) {
      return {
        providerId,
        status: "ok",
        message: "The provider accepted this credential.",
        httpStatus: response.status,
        checkedAt,
        latencyMs,
      };
    }
    let body = "";
    try {
      body = (await response.text()).slice(0, MAX_BODY_CHARS * 2);
    } catch {
      /* a body we cannot read does not change the verdict */
    }
    const failure = describeFailure(response.status, body, input.auth.type === "api" ? input.auth.key : input.auth.access ?? "");
    return { providerId, ...failure, httpStatus: response.status, checkedAt, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      providerId,
      status: "unreachable",
      message: aborted
        ? `The provider did not respond within ${Math.round((input.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`
        : `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
