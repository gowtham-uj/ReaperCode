/**
 * exec-runner — drive the runtime engine from the CLI with a single
 * prompt and yolo-level permissions. Used by `reaper exec` and by
 * ad-hoc scripts that want a self-contained Reaper run.
 *
 * "Yolo" here means the engine is launched with:
 *   - Permissive runtime controls (no progress/completion/editor guards)
 *   - no tool allowlist narrowing
 *   - one completion-gate attempt, no follow-up vote rounds
 *
 * The completion gate still requires an explicit `complete_task`
 * signal — we do NOT relax that, because silently declaring a run
 * "complete" is what causes synthetic completions and unreliable
 * success signals. Auto-approve is about the *gating* layer, not
 * the *evidence* layer.
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
import type { ModelCapabilities } from "../model/types.js";

type ExecProvider = "anthropic" | "openai" | "minimax" | "deepseek" | "nuralwatt" | "nuralwatt2";

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
}

export interface ExecRunnerResult {
  status: "completed" | "failed" | "aborted";
  assistantMessage: string;
  toolResults: Array<{ id: string; name: string; result: unknown }>;
  trajectoryPath: string;
  contentFingerprint?: string;
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

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  toolCalling: true,
  jsonMode: true,
  structuredOutput: true,
  embeddings: false,
};

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
        ? "exec with --provider openai requires OPENAI_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment"
        : "exec requires ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in the environment",
    );
  }
  const model = opts.model ?? process.env.ANTHROPIC_MODEL ?? (provider === "minimax" ? "MiniMax-M3" : (provider === "nuralwatt" || provider === "nuralwatt2") ? "kimi-k2.7-code" : "claude-sonnet-4-6");
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

/**
 * Minimal exec-mode environment prompt.
 *
 * Keep this short and action-oriented: the model should inspect only when
 * useful, write required files directly, run the requested verification,
 * then stop naturally with final text once no work remains.
 */
const YOLO_SYSTEM_PROMPT = [
  "[exec environment — single-prompt run, no approval gate]",
  "Workspace: ${WORKSPACE}",
  "Tool rules:",
  "  1. Stay inside the workspace. Every file path should resolve under ${WORKSPACE}.",
  "  2. Use write_file for new files/full rewrites. For targeted edits to existing files, first inspect exact line numbers with file_view/file_find/file_scroll, then use file_edit. Do not create source files through shell heredocs or redirection.",
  "  3. Shell calls start in ${WORKSPACE}; use relative paths from that root or chain commands explicitly.",
  "  4. Prefer file_view/file_find/file_scroll for source inspection; use bash for verification, package-manager commands, and commands that genuinely need a shell.",
  "  5. For simple file-creation tasks, create the required files directly, then run the requested test/check command. Do not re-read files you just wrote unless a check fails or you need specific missing information.",
  "  6. When the requested work is complete and the relevant test/check passes, finish with a concise final assistant message and no tool calls. Do not keep inspecting after completion.",
  "[end exec environment]",
  "",
  "User prompt:",
  "",
].join("\n");

function renderPrompt(opts: ExecRunnerOptions): string {
  return YOLO_SYSTEM_PROMPT.replace(/\$\{WORKSPACE\}/g, opts.workspaceRoot) + opts.prompt;
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
    },
    payload: {
      prompt: renderPrompt(opts),
      ...(opts.toolCalls ? { tool_calls: opts.toolCalls } : {}),
    },
  };
}

export async function runExec(opts: ExecRunnerOptions): Promise<ExecRunnerResult> {
  const startedAt = Date.now();
  let config: unknown;
  try {
    config = buildConfig(opts);
  } catch (e) {
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
  const client = new ProviderMultiplexerClient();
  const gateway = new ConfiguredModelGateway(config, client);
  const requestEnvelope = buildRequestEnvelope(opts);
  const abort = new AbortController();
  const engine = new RuntimeEngine({
    config,
    workspaceRoot: opts.workspaceRoot,
    requestEnvelope,
    modelGateway: gateway,
    abortSignal: abort.signal,
  });
  // Default: no CLI-side wall-clock timer. The run is bounded by the
  // model's own natural-stop decision (an assistant turn with no tool
  // calls), not by a Reaper-side clock. This honours the rule that
  // the model owns the stop decision. Operators who need a hard cap
  // can pass --timeout-ms N. N=0 is the canonical "no Reaper timer".
  const timeoutMs = opts.timeoutMs ?? 0;
  const timer = timeoutMs > 0 ? setTimeout(() => abort.abort(), timeoutMs) : undefined;
  try {
    const result = await engine.run();
    const v = result.verification;
    return {
      status: deriveExecFinalStatus({
        aborted: abort.signal.aborted,
        verification: v,
        events: result.events,
      }),
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
    };
  } catch (e) {
    return {
      status: "failed",
      assistantMessage: "",
      toolResults: [],
      trajectoryPath: "",
      events: 0,
      durationMs: Date.now() - startedAt,
      notices: [{ kind: "error", message: e instanceof Error ? e.message : String(e) }],
    };
  } finally {
    clearTimeout(timer);
    try {
      await gateway.dispose();
    } catch {
      /* ignore */
    }
  }
}
