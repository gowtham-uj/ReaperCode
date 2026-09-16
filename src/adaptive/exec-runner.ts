/**
 * exec-runner — drive the runtime engine from the CLI with a single
 * prompt and yolo-level permissions. Used by `reaper exec` and by
 * ad-hoc scripts that want a self-contained Reaper run.
 *
 * "Yolo" here means the engine is launched with permissive runtime controls
 * and no tool allowlist narrowing. The model ends the run naturally by
 * returning a final assistant message with no tool calls.
 *
 * The model gateway uses the Anthropic client. The auth token is
 * pulled from `ANTHROPIC_AUTH_TOKEN` first (so a proxy like
 * api.minimax.io works out of the box) and falls back to
 * `ANTHROPIC_API_KEY` (the standard Anthropic SDK env name).
 * The base URL comes from `ANTHROPIC_BASE_URL` — also via the
 * Anthropic client — so this same runner drives both
 * api.anthropic.com and any Anthropic-compatible proxy.
 *
 * No raw secret ever leaves this module's runtime: it is read
 * from the env, copied into `process.env.ANTHROPIC_API_KEY` for
 * the duration of the run, and never embedded in the config
 * object that gets persisted to disk.
 */

import { RuntimeEngine } from "../runtime/engine.js";
import { ConfiguredModelGateway } from "../model/gateway.js";
import { ProviderMultiplexerClient } from "../model/providers/provider-client.js";
import type { ModelCapabilities as ProfileModelCapabilities } from "../model/types.js";
import type { ModelCapabilities as AdaptiveModelCapabilities } from "./types.js";
import { ModelCapabilitiesRegistry } from "./model-capabilities.js";
import { isValidSessionName } from "../context/session-journal.js";
import { TrajectoryLogger } from "../logging/trajectory.js";
import { randomUUID } from "node:crypto";
import path from "node:path";

export type ExecProvider = "anthropic" | "openai" | "minimax" | "deepseek" | "nuralwatt" | "nuralwatt2";

export interface ExecRunnerOptions {
  workspaceRoot: string;
  prompt: string;
  /** Override the default yolo model. Default: ANTHROPIC_MODEL. */
  model?: string;
  /** Per-run max output tokens. Default 4096. */
  maxTokens?: number;
  /** Optional per-run timeout in ms. Default 10 min. */
  timeoutMs?: number;
  /** Optional explicit tool-call list (skips the model turn). */
  toolCalls?: unknown[];
  /** Optional transport kind override. Default "http_json". */
  transport?: "http_json" | "http_sse" | "stdio" | "websocket" | "webhook";
  /**
   * Provider family. Default "anthropic" — uses ANTHROPIC_AUTH_TOKEN +
   * ANTHROPIC_BASE_URL + the AnthropicClient. Set to "openai" to use an
   * OpenAI-compatible endpoint via the LiteLLM gateway client; the
   * runner reads OPENAI_BASE_URL + OPENAI_API_KEY and forwards
   * `reasoning_effort` from `reasoningEffort`. Set to "minimax" to
   * route MiniMax-M3 through api.minimax.io (OpenAI-compatible) — the
   * base URL is hardcoded so callers only need the API key.
   */
  provider?: ExecProvider;
  /**
   * Reasoning effort for OpenAI-compatible providers that support
   * `reasoning_effort` (e.g. MiniMax-M3 on api.minimax.io).
   * Default: "medium".
   */
  reasoningEffort?: "low" | "medium" | "high";
  /**
   * Thinking channel for all providers. Default: enabled.
   * Pass "disabled" for latency-sensitive runs.
   */
  thinking?: "enabled" | "disabled";
  /**
   * Named session for cross-run continuity. Runs sharing a --session name
   * journal their turns under `.reaper/sessions/<name>/session.jsonl` and
   * rehydrate the prior conversation on the next run.
   */
  session?: string;
}

/**
 * Pure mapping from engine output + abort signal to the exec-runner status.
 * Extracted so it can be unit-tested without spinning up the runtime.
 *
 *   - verification.ok === true  -> "completed"
 *   - verification.ok === false -> "failed"
 *   - "task_completed" event present (autonomous natural stop) -> "completed"
 *   - aborted and no verification -> "aborted"
 *   - otherwise -> "failed"
 */
export function deriveExecFinalStatus(input: {
  aborted: boolean;
  verification: { ok: boolean } | undefined;
  events: ReadonlyArray<{ message_type?: string }> | undefined;
}): "completed" | "failed" | "aborted" {
  if (input.verification?.ok === true) return "completed";
  if (input.verification?.ok === false) return "failed";
  if (input.events?.some((e) => e.message_type === "task_completed")) return "completed";
  if (input.aborted) return "aborted";
  return "failed";
}

const DEFAULT_CAPABILITIES: ProfileModelCapabilities = {
  streaming: true,
  toolCalling: true,
  jsonMode: true,
  structuredOutput: true,
  embeddings: false,
  // Vision is opt-in: none of the text-first exec providers (deepseek,
  // kimi, miniMax, etc.) are marked vision-capable here. Set imageInput
  // via an explicit profile to enable the screenshot/computer-bridge path.
  imageInput: false,
  videoInput: false,
};

/**
 * Resolve the exec config's model capabilities into the adaptive
 * registry shape. The exec config advertises the profile contract
 * (`streaming`/`toolCalling`/`imageInput`/...); the adaptive registry
 * (and thus `VisualInputAnalyzer.isAvailable()`) reads
 * `imageInput`/`videoInput`/`toolUse`. `fromProfile` is the single
 * migration point between the two contracts.
 */
export function resolveExecCapabilities(config: unknown): AdaptiveModelCapabilities {
  const profile = extractProfileCapabilities(config);
  return ModelCapabilitiesRegistry.fromProfile(profile).current();
}

function extractProfileCapabilities(config: unknown): ProfileModelCapabilities {
  const models = (config as { models?: Record<string, { capabilities?: ProfileModelCapabilities } | undefined> }).models;
  const defaultModel = models?.["default_model"];
  const caps = defaultModel?.capabilities;
  if (!caps) {
    // Fall back to the safe minimum when the config has no capabilities
    // block (should not happen — buildConfig always sets one).
    return { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false, imageInput: false, videoInput: false };
  }
  return caps;
}

/**
 * The model to use when the caller named a provider but no model.
 *
 * Every provider except anthropic used to fall through to
 * `claude-sonnet-4-6`, so `--provider deepseek` sent Anthropic's model name to
 * DeepSeek's API, which answered `HTTP 400 — the supported API model names are
 * deepseek-flash, deepseek-v4-pro, but you passed claude-sonnet-4-6`. The
 * provider was honoured and the model was not, and the mismatch surfaced as a
 * provider error rather than as a bad default here.
 *
 * A complete union, so adding a provider without a model for it is a type
 * error rather than a silent fallback to somebody else's model.
 */
function defaultModelFor(provider: ExecProvider): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-6";
    case "minimax": return "MiniMax-M3";
    case "nuralwatt":
    case "nuralwatt2": return "kimi-k2.7-code";
    // DeepSeek's current flash model, which is what `exec` wants: a
    // single-prompt runner has nothing to gain from a reasoning model's
    // latency. `deepseek-v4-pro` remains selectable with `--model`.
    case "deepseek": return "deepseek-flash";
    // No default is asserted for `openai`: the account's available models are
    // not knowable from here, and `gpt-4o-mini` may not exist on a given key.
    // Naming it is the caller's job, and the error from the provider says so.
    case "openai": return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    default: {
      const exhaustive: never = provider;
      return exhaustive;
    }
  }
}

function pickAuthToken(provider: ExecProvider): string | undefined {
  if (provider === "minimax") {
    return process.env.MINIMAX_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "nuralwatt") {
    return process.env.NURALWATT_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "nuralwatt2") {
    return process.env.NURALWATT_API_KEY2 ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "deepseek") {
    return process.env.DEEPSEEK_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "openai") {
    return process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
  }
  return process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
}

export function resolveBaseUrl(): string {
  // Anthropic SDK convention: ANTHROPIC_BASE_URL points at the host root
  // and the client appends "/messages". Anthropic's own gateway serves
  // "/v1/messages", so the canonical base is ".../v1". Some Anthropic-
  // compatible proxies (e.g. api.minimax.io) expose their proxy at a
  // path that already includes /v1 via the host — in that case the env
  // var is already ".../anthropic" and the client appends "/messages"
  // to land on the proxy's "messages" endpoint, which is a 404.
  //
  // Resolution rule:
  //   - if ANTHROPIC_BASE_URL ends in "/v1", use it as-is
  //   - else if ANTHROPIC_BASE_URL ends in "/v1/", strip the trailing /
  //   - else, append "/v1" (so the client request hits .../v1/messages)
  const raw = process.env.ANTHROPIC_BASE_URL;
  if (!raw) return "https://api.anthropic.com/v1";
  const trimmed = raw.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) return trimmed;
  return `${trimmed}/v1`;
}

export function buildConfig(opts: ExecRunnerOptions): unknown {
  const provider = opts.provider ?? "anthropic";
  const authToken = pickAuthToken(provider);
  if (!authToken) {
    throw new Error(
      provider === "minimax"
        ? "exec with --provider minimax requires MINIMAX_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment"
        : provider === "deepseek"
        ? "exec with --provider deepseek requires DEEPSEEK_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment"
        : provider === "nuralwatt"
        ? "exec with --provider nuralwatt requires NURALWATT_API_KEY in the environment"
        : provider === "nuralwatt2"
        ? "exec with --provider nuralwatt2 requires NURALWATT_API_KEY2 in the environment"
        : provider === "openai"
        ? `exec with --provider ${provider} requires OPENAI_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment`
        : "exec requires ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in the environment",
    );
  }
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? defaultModelFor(provider);
  const maxTokens = opts.maxTokens ?? 4096;
  if (provider === "openai" || provider === "minimax" || provider === "deepseek" || provider === "nuralwatt" || provider === "nuralwatt2") {
    // OpenAI-compatible: the LiteLLM gateway client reads from
    // OPENAI_API_KEY + the apiBase on the profile. We forward
    // `reasoning_effort` from the configured effort. For `minimax`,
    // the base URL is hardcoded by `resolveProviderDefaults` to
    // https://api.minimax.io/v1 — callers do not need OPENAI_BASE_URL.
    // For `deepseek`, the multiplexer dispatches to the native
    // DeepSeek client which reads DEEPSEEK_API_KEY (not OPENAI_API_KEY),
    // so we seed only DEEPSEEK_API_KEY and never touch OPENAI_API_KEY.
    if (provider === "deepseek") {
      process.env.DEEPSEEK_API_KEY = authToken;
    } else if (provider === "nuralwatt") {
      process.env.NURALWATT_API_KEY = authToken;
    } else if (provider === "nuralwatt2") {
      process.env.NURALWATT_API_KEY2 = authToken;
    } else {
      process.env.OPENAI_API_KEY = authToken;
    }
    const apiBase = provider === "minimax"
      ? "https://api.minimax.io/v1"
      : (provider === "nuralwatt" || provider === "nuralwatt2")
        ? "https://api.neuralwatt.com/v1"
        : provider === "deepseek"
        ? "https://api.deepseek.com"
        : (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const reasoningEffort = opts.reasoningEffort ?? "medium";
    return {
      models: {
        default_model: {
          provider: provider === "minimax"
            ? "minimax"
            : provider === "deepseek"
              ? "deepseek"
              : provider === "nuralwatt"
                ? "nuralwatt"
                : provider === "nuralwatt2"
                  ? "nuralwatt2"
                  : "litellm",
          model,
          apiBase,
          apiKeyEnv: provider === "deepseek" ? "DEEPSEEK_API_KEY" : provider === "nuralwatt" ? "NURALWATT_API_KEY" : provider === "nuralwatt2" ? "NURALWATT_API_KEY2" : "OPENAI_API_KEY",
          timeoutMs: 600_000,
          maxRetries: 2,
          capabilities: DEFAULT_CAPABILITIES,
          defaultParams: {
            maxTokens,
            temperature: 0,
            reasoningEffort,
            ...(opts.thinking ? { thinking: opts.thinking } : {}),
          },
        },
      },
      modelRouting: {
        planner: "default_model",
        executor: "default_model",
        summarizer: "default_model",
      },
      runtime: { voteAttempts: 1 },
      // `permissionMode` belongs to `runtimeTunables`, not `runtime`
      // (model-config.ts:358). `ReaperConfigSchema` is strict, so putting it
      // under `runtime` made every config this builds fail to parse.
      //
      // Explicit, though it now matches the default everywhere else.
      // `reaper exec` is the non-interactive single-prompt runner: it has no
      // way to surface an approval prompt, so anything other than yolo would
      // turn "needs confirmation" into a hard refusal.
      runtimeTunables: { permissionMode: "yolo" },
    };
  }
  // Inject the auth token into the standard env var name so the
  // AnthropicClient picks it up at request time. We do NOT embed
  // the token in the config object that gets persisted to disk.
  process.env.ANTHROPIC_API_KEY = authToken;
  // Resolve and inject the base URL so the client request lands on
  // the right path (some Anthropic-compatible proxies do not include
  // "/v1" in their ANTHROPIC_BASE_URL).
  process.env.ANTHROPIC_BASE_URL = resolveBaseUrl();
  return {
    models: {
      default_model: {
        provider: "anthropic",
        model,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        timeoutMs: 600_000,
        maxRetries: 2,
        capabilities: DEFAULT_CAPABILITIES,
        defaultParams: {
          maxTokens,
          temperature: 0,
          ...(opts.thinking ? { thinking: opts.thinking } : {}),
        },
      },
    },
    modelRouting: {
      planner: "default_model",
      executor: "default_model",
      summarizer: "default_model",
    },
    runtime: { voteAttempts: 1 },
    runtimeTunables: { permissionMode: "yolo" },
  };
}

import { findProviderDescriptor } from "../model/provider/catalog.js";

/**
 * buildConfigForProvider — the data-driven counterpart to
 * `buildConfig`. Resolves a provider id against the registry
 * catalog and returns a `ReaperConfig` shape that's structurally
 * identical to what `buildConfig` would have produced for that
 * provider. Use this from any new caller; the legacy
 * `buildConfig(opts)` is preserved for the `reaper exec run` path
 * that takes `--provider <string>` directly.
 */
export function buildConfigForProvider(args: {
  workspaceRoot: string;
  providerId: string;
  modelId?: string;
  reasoningEffort?: "low" | "medium" | "high";
}): unknown {
  const descriptor = findProviderDescriptor(args.providerId);
  if (!descriptor) {
    throw new Error(`unknown provider "${args.providerId}"`);
  }
  const modelId = args.modelId ?? descriptor.defaultModel;

  // Every provider is described entirely by its catalog descriptor. The
  // multiplexer still dispatches ids like `anthropic` and `deepseek` to their
  // dedicated clients, so nothing is lost by resolving the profile from data.
  const capabilities: ProfileModelCapabilities = {
    ...DEFAULT_CAPABILITIES,
    ...descriptor.capabilities,
  };
  return {
    models: {
      default_model: {
        provider: descriptor.id,
        model: modelId,
        ...(descriptor.baseUrl ? { apiBase: descriptor.baseUrl } : {}),
        ...(descriptor.envVar ? { apiKeyEnv: descriptor.envVar } : {}),
        timeoutMs: 600_000,
        maxRetries: 2,
        capabilities,
        defaultParams: {
          maxTokens: 4096,
          temperature: 0,
          ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
        },
      },
    },
    modelRouting: {
      planner: "default_model",
      executor: "default_model",
      summarizer: "default_model",
    },
    runtime: { voteAttempts: 1 },
    runtimeTunables: { permissionMode: "yolo" },
  };
}


export function buildRequestEnvelope(opts: ExecRunnerOptions): unknown {
  const ts = new Date().toISOString();
  const sessionId = `exec-${Date.now()}`;
  return {
    connection_id: "exec-cli",
    session_id: sessionId,
    turn_id: `${sessionId}-t0`,
    request_id: `${sessionId}-r0`,
    message_type: "user_prompt" as const,
    timestamp: ts,
    trace_id: sessionId,
    metadata: {
      transport: opts.transport ?? "http_json",
      yolo: true,
      ...(opts.session ? { namedSession: opts.session, session: opts.session } : {}),
    },
    payload: {
      prompt: opts.prompt,
      ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
    },
  };
}
