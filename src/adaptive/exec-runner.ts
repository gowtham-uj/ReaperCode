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

type ExecProvider = "anthropic" | "openai" | "openai-codex" | "minimax" | "deepseek" | "nuralwatt" | "nuralwatt2";

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
   * Named session for cross-run continuity. Runs sharing a --session
   * name journal their user/assistant turns under
   * `.reaper/sessions/<name>.jsonl` and rehydrate the prior
   * conversation on the next boot.
   */
  session?: string;
}

export interface ExecRunnerResult {
  status: "completed" | "failed" | "aborted";
  assistantMessage: string;
  toolResults: Array<{ id: string; name: string; result: unknown }>;
  trajectoryPath: string;
  contentFingerprint?: string;
  /**
   * The model's resolved capability set, migrated to the adaptive
   * registry shape (imageInput/videoInput/toolUse/...). Present on every
   * run, including failures that happen after config build, so callers
   * can gate the visual/computer-bridge path from the same truth the
   * exec providers advertised — instead of a permanently-undefined
   * `imageInput` (see C2).
   */
  capabilities?: AdaptiveModelCapabilities;
  verification?: {
    ok: boolean;
    reason?: string;
    attemptCount: number;
  };
  events: number;
  durationMs: number;
  notices: Array<{ kind: string; message: string }>;
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
  if (provider === "openai" || provider === "openai-codex") {
    return process.env[provider === "openai-codex" ? "OPENAI_CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY"] ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY;
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
        : provider === "openai" || provider === "openai-codex"
        ? `exec with --provider ${provider} requires ${provider === "openai-codex" ? "OPENAI_CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY"} (or ANTHROPIC_AUTH_TOKEN) in the environment`
        : "exec requires ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in the environment",
    );
  }
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? (provider === "minimax" ? "MiniMax-M3" : (provider === "nuralwatt" || provider === "nuralwatt2") ? "kimi-k2.7-code" : "claude-sonnet-4-6");
  const maxTokens = opts.maxTokens ?? 4096;
  if (provider === "openai" || provider === "openai-codex" || provider === "minimax" || provider === "deepseek" || provider === "nuralwatt" || provider === "nuralwatt2") {
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
    } else if (provider === "openai-codex") {
      process.env.OPENAI_CODEX_ACCESS_TOKEN = authToken;
    } else {
      process.env.OPENAI_API_KEY = authToken;
    }
    const apiBase = provider === "minimax"
      ? "https://api.minimax.io/v1"
      : (provider === "nuralwatt" || provider === "nuralwatt2")
        ? "https://api.neuralwatt.com/v1"
        : provider === "deepseek"
        ? "https://api.deepseek.com"
        : provider === "openai-codex"
        ? "https://chatgpt.com/backend-api/codex"
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
                  : provider === "openai-codex"
                    ? "openai-codex"
                    : "litellm",
          model,
          apiBase,
          apiKeyEnv: provider === "deepseek" ? "DEEPSEEK_API_KEY" : provider === "nuralwatt" ? "NURALWATT_API_KEY" : provider === "nuralwatt2" ? "NURALWATT_API_KEY2" : provider === "openai-codex" ? "OPENAI_CODEX_ACCESS_TOKEN" : "OPENAI_API_KEY",
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
      runtime: {
        voteAttempts: 1,
        // `reaper exec` is the explicit single-prompt, non-interactive
        // runner — it is intentionally yolo. Every other entrypoint
        // defaults to accept_edits.
        permissionMode: "yolo",
      },
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
    runtime: {
      voteAttempts: 1,
      permissionMode: "yolo",
    },
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
}): unknown {
  const descriptor = findProviderDescriptor(args.providerId);
  if (!descriptor) {
    throw new Error(`unknown provider "${args.providerId}"`);
  }
  const modelId = args.modelId ?? descriptor.defaultModel;
  return buildConfig({
    workspaceRoot: args.workspaceRoot,
    prompt: "",
    model: modelId,
    provider: args.providerId as "openai" | "anthropic" | "deepseek" | "minimax" | "nuralwatt" | "nuralwatt2",
  });
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

/**
 * Environment variables `buildConfig` writes so the provider clients pick
 * up credentials at request time. `runExec` snapshots these before
 * building the config and restores them when the run ends, so a single
 * `exec` call does not permanently rewrite the credentials of a
 * long-lived host process that embeds the runner.
 */
const EXEC_MUTATED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "DEEPSEEK_API_KEY",
  "NURALWATT_API_KEY",
  "NURALWATT_API_KEY2",
] as const;

function snapshotExecEnv(): Map<string, string | undefined> {
  return new Map(EXEC_MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreExecEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function runExec(opts: ExecRunnerOptions): Promise<ExecRunnerResult> {
  const startedAt = Date.now();
  const envSnapshot = snapshotExecEnv();
  let config: unknown;
  try {
    config = buildConfig(opts);
  } catch (e) {
    restoreExecEnv(envSnapshot);
    return {
      status: "failed",
      assistantMessage: "",
      toolResults: [],
      trajectoryPath: "",
      events: 0,
      durationMs: Date.now() - startedAt,
      notices: [{ kind: "error", message: e instanceof Error ? e.message : String(e) }],
    };
  }
  if (opts.session !== undefined && !isValidSessionName(opts.session)) {
    restoreExecEnv(envSnapshot);
    return {
      status: "failed",
      assistantMessage: "",
      toolResults: [],
      trajectoryPath: "",
      events: 0,
      durationMs: Date.now() - startedAt,
      notices: [{ kind: "error", message: `invalid --session name "${opts.session}" (allowed: letters, digits, ., _, - ; max 128 chars)` }],
    };
  }
  const client = new ProviderMultiplexerClient();
  const gateway = new ConfiguredModelGateway(config, client);
  const requestEnvelope = buildRequestEnvelope(opts);
  // C2: resolve the model's advertised capabilities into the adaptive
  // registry shape up front, so a caller can gate the visual path on
  // the same truth the provider advertised (rather than undefined).
  const capabilities = resolveExecCapabilities(config);
  const abort = new AbortController();
  const engine = new RuntimeEngine({
    config,
    workspaceRoot: opts.workspaceRoot,
    requestEnvelope,
    modelGateway: gateway,
    abortSignal: abort.signal,
    ...(opts.session ? { namedSession: opts.session } : {}),
  });
  // Default: no CLI-side wall-clock timer. The run is bounded by the
  // model's own natural-stop decision (an assistant turn with no tool
  // calls), not by a Reaper-side clock. This honours the rule that
  // the model owns the stop decision. Operators who need a hard cap
  // can pass --timeout-ms N. N=0 is the canonical "no Reaper timer".
  const timeoutMs = opts.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => abort.abort(), timeoutMs) : undefined;
  // Ctrl-C / SIGTERM must unwind through the same path as a timeout:
  // abort the engine so `finally` runs (gateway disposed, `run_end`
  // envelope appended, env restored). Without this the default signal
  // disposition kills the process mid-run, leaking the provider
  // connection and truncating the trajectory with no terminal event.
  const onSignal = (): void => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // Terminal `run_end` envelope appended to the same trajectory file
  // the engine is writing — keeps the live stream readable for
  // harnesses that `tail -f` the JSONL or pipe stdout (--stream-events).
  let runEndEmitter: { logger: TrajectoryLogger; runId: string } | undefined;
  try {
    const result = await engine.run();
    const v = result.verification;
    const status = deriveExecFinalStatus({
      aborted: abort.signal.aborted,
      verification: v,
      events: result.events,
    });
    runEndEmitter = {
      logger: new TrajectoryLogger(opts.workspaceRoot, { runId: deriveRunIdFromTrajectoryPath(result.trajectoryPath) }),
      runId: deriveRunIdFromTrajectoryPath(result.trajectoryPath),
    };
    await emitRunEnd({
      emitter: runEndEmitter,
      status,
      finalAssistantMessage: result.assistantMessage ?? "",
      durationMs: Date.now() - startedAt,
    });
    return {
      status,
      assistantMessage: result.assistantMessage ?? "",
      toolResults: (result.toolResults ?? []).map((tr) => ({
        id: String((tr as { call_id?: string }).call_id ?? ""),
        name: String((tr as { name?: string }).name ?? ""),
        result: (tr as { result?: unknown }).result,
      })),
      trajectoryPath: result.trajectoryPath,
      ...(result.contentFingerprint ? { contentFingerprint: result.contentFingerprint } : {}),
      ...(v
        ? {
            verification: {
              ok: v.ok,
              ...(v.feedback?.[0] ? { reason: v.feedback[0] } : {}),
              attemptCount: v.attemptCount,
            },
          }
        : {}),
      events: result.events?.length ?? 0,
      durationMs: Date.now() - startedAt,
      notices: (result.notices ?? []).map((n) => ({
        kind: String((n as { kind?: string }).kind ?? "info"),
        message: String((n as { message?: string }).message ?? ""),
      })),
      capabilities,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // If the engine threw before producing a trajectory path, fall
    // back to a run-agnostic TrajectoryLogger so the failed-run_end
    // envelope still lands somewhere a harness can find it.
    if (!runEndEmitter) {
      runEndEmitter = {
        logger: new TrajectoryLogger(opts.workspaceRoot),
        runId: "exec",
      };
    }
    await emitRunEnd({
      emitter: runEndEmitter,
      status: "failed",
      finalAssistantMessage: message,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "failed",
      assistantMessage: "",
      toolResults: [],
      trajectoryPath: "",
      events: 0,
      durationMs: Date.now() - startedAt,
      notices: [{ kind: "error", message }],
      capabilities,
    };
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      await gateway.dispose();
    } catch {
      /* ignore */
    }
    restoreExecEnv(envSnapshot);
  }
}

/**
 * Pull the run/session id off the engine's session path
 * (`.../logs/<id>/session.jsonl`).
 */
function deriveRunIdFromTrajectoryPath(p: string): string {
  if (!p) return "exec";
  const parts = p.split(path.sep);
  const idx = parts.lastIndexOf("logs");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1] ?? "exec";
  return path.basename(path.dirname(p)) || "exec";
}
async function emitRunEnd(input: {
  emitter: { logger: TrajectoryLogger; runId: string };
  status: "completed" | "failed" | "aborted";
  finalAssistantMessage: string;
  durationMs: number;
}): Promise<void> {
  try {
    await input.emitter.logger.write({
      event_id: randomUUID(),
      run_id: input.emitter.runId,
      session_id: "exec",
      trace_id: input.emitter.runId,
      timestamp: new Date().toISOString(),
      log_schema_version: 1,
      kind: "run_end",
      level: "info",
      status: input.status,
      final_assistant_message: input.finalAssistantMessage,
      duration_ms: input.durationMs,
    });
  } catch {
    /* run_end is best-effort metadata; never break the run */
  }
}


