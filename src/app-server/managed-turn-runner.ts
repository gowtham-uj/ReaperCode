import { buildConfig, buildConfigForProvider } from "../adaptive/exec-runner.js";
import { ProviderCredentialStore } from "../config/provider-credentials.js";
import { ConfiguredModelGateway } from "../model/gateway.js";
import { resolveDefaultSelection } from "../model/provider/default-selection.js";
import { ProviderMultiplexerClient } from "../model/providers/provider-client.js";
import type { PermissionMode } from "../policy/classifier.js";
import { RuntimeEngine, type RuntimeEngineResult } from "../runtime/engine.js";
import type { RuntimeEventSink, RuntimeTurnControl } from "../runtime/events.js";
import type { ToolApprovalRequester } from "../tools/approval.js";

export interface ManagedTurnRunnerInput {
  threadId: string;
  turnId: string;
  sessionName: string;
  workspaceRoot: string;
  prompt: string;
  provider?: string;
  model?: string;
  reasoningEffort?: "low" | "medium" | "high";
  permissionMode: PermissionMode;
  abortSignal: AbortSignal;
  eventSink: RuntimeEventSink;
  turnControl: RuntimeTurnControl;
  approvalRequester: ToolApprovalRequester;
  /** Snapshotted from the thread's metadata when the turn starts. */
  systemPrompt?: string;
  disabledTools?: string[];
}

export type ManagedTurnRunner = (input: ManagedTurnRunnerInput) => Promise<RuntimeEngineResult>;

/**
 * Which provider and model a turn runs on, resolved in one place.
 *
 * Exported because this precedence rule is the whole fix and it has no other
 * way to be tested: `runManagedTurn` immediately builds a config, constructs a
 * gateway, and starts an engine, so a test that reached this through the
 * runner would be testing the engine rather than the rule.
 *
 * An explicit thread selection always wins — that is what the model picker
 * sets, and a thread pinned to a model must keep it. Only when the thread
 * names nothing does the user's configured credentials decide.
 */
export function selectTurnModel(
  input: Pick<ManagedTurnRunnerInput, "provider" | "model">,
  credentials: Pick<ProviderCredentialStore, "list" | "secretFor">,
): { provider: string; model?: string } | undefined {
  if (input.provider) {
    return { provider: input.provider, ...(input.model ? { model: input.model } : {}) };
  }
  return resolveDefaultSelection(credentials);
}

/** Creates one fresh engine while reusing the thread's named-session journal. */
export const runManagedTurn: ManagedTurnRunner = async (input) => {
  // Read the store once per turn, not once per process: a key added in
  // Settings has to work for the very next turn without a server restart.
  // Resolution stays per-profile, so a turn whose fallback lives on a
  // different provider gets that provider's key rather than the primary's.
  const credentials = new ProviderCredentialStore();
  /*
   * A thread that names no provider is not a thread that should run on
   * `anthropic` — it is a thread whose provider has not been decided. See
   * `selectTurnModel` and `resolveDefaultSelection` for why falling through to
   * `buildConfig` here made every new chat fail for a user who had configured
   * a different provider.
   */
  const selected = selectTurnModel(input, credentials);
  const baseConfig = selected
    ? buildConfigForProvider({
        workspaceRoot: input.workspaceRoot,
        providerId: selected.provider,
        ...(selected.model ? { modelId: selected.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      })
    : buildConfig({
        workspaceRoot: input.workspaceRoot,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      });
  const config = withPermissionMode(baseConfig, input.permissionMode);
  // Transport option shaping (Bedrock region, Vertex project, Azure resource,
  // Cloudflare account) reads only non-secret metadata. Passing it through the
  // client rather than the process environment keeps concurrent threads on
  // different providers from overwriting each other's settings.
  const providerClient = new ProviderMultiplexerClient({
    aiSdkOptions: { metadataFor: (providerId) => credentials.metadataFor(providerId) },
  });
  const gateway = new ConfiguredModelGateway(config, providerClient, {
    credentialFor: (providerId) => {
      const apiKey = credentials.secretFor(providerId);
      const baseUrl = credentials.baseUrlFor(providerId);
      // A custom endpoint is not authentication. In particular, an expired
      // OAuth account may still carry an enterprise URL; do not turn that into
      // an unauthenticated model request after `secretFor` withholds its token.
      if (!apiKey) return undefined;
      return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
    },
  });
  const timestamp = new Date().toISOString();
  const requestEnvelope = {
    connection_id: "app-server",
    session_id: input.threadId,
    turn_id: input.turnId,
    request_id: `${input.turnId}-request`,
    message_type: "user_prompt" as const,
    timestamp,
    trace_id: input.turnId,
    metadata: {
      transport: "websocket",
      yolo: input.permissionMode === "yolo",
      namedSession: input.sessionName,
      session: input.sessionName,
      threadId: input.threadId,
    },
    payload: { prompt: input.prompt },
  };

  try {
    const engine = new RuntimeEngine({
      config,
      workspaceRoot: input.workspaceRoot,
      requestEnvelope,
      modelGateway: gateway,
      abortSignal: input.abortSignal,
      namedSession: input.sessionName,
      eventSink: input.eventSink,
      turnControl: input.turnControl,
      approvalRequester: input.approvalRequester,
      writeHumanOutput: false,
      // The thread's own instructions and tool policy, read off the metadata
      // snapshot `ManagedReaperThread.executeTurn` took when this turn began.
      // Taking them from the snapshot (rather than re-reading the thread) is
      // what makes "applies to the next turn" true rather than approximate: a
      // save that lands mid-run cannot change the prompt this run already sent.
      ...(input.systemPrompt ? { systemPromptSuffix: input.systemPrompt } : {}),
      ...(input.disabledTools?.length ? { disabledTools: input.disabledTools } : {}),
    });
    return await engine.run();
  } finally {
    await gateway.dispose().catch(() => undefined);
  }
};

function withPermissionMode(config: unknown, permissionMode: PermissionMode): unknown {
  const record = asRecord(config) ?? {};
  // `permissionMode` lives under `runtimeTunables`, not `runtime`
  // (model-config.ts:358). `ReaperConfigSchema` is strict, so writing it to the
  // wrong key made every app-server turn fail validation before it began.
  return {
    ...record,
    runtimeTunables: {
      ...(asRecord(record.runtimeTunables) ?? {}),
      permissionMode,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
