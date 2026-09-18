import type { ThreadBrowserRuntime } from "../browser/thread-runtime.js";
import { buildConfig, buildConfigForProvider } from "../adaptive/exec-runner.js";
import { ProviderCredentialStore } from "../config/provider-credentials.js";
import { ConfiguredModelGateway } from "../model/gateway.js";
import { resolveDefaultSelection } from "../model/provider/default-selection.js";
import { readDisabledProviders } from "./settings-surface.js";
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
  /** Whether shell commands are confined to the workspace. Default true. */
  filesystemSandbox?: boolean;
  abortSignal: AbortSignal;
  eventSink: RuntimeEventSink;
  turnControl: RuntimeTurnControl;
  approvalRequester: ToolApprovalRequester;
  /**
   * The thread's browser, when the server owns one.
   *
   * Passed in rather than constructed here, because a browser per turn would
   * lose every login at the end of the turn, which is the one thing the
   * attached-browser design exists to prevent. Absent in tests and in any
   * embedded server that did not create one, and `browser_use` then reports that
   * no browser is attached rather than hanging on a connection that cannot exist.
   */
  threadBrowser?: ThreadBrowserRuntime;
  /**
   * Called when an error escapes the run, to cancel this turn rather than the
   * process.
   *
   * The app-server hosts every thread in one process, so a fault raised inside
   * one thread's tool call must stop that thread and nothing else. The thread
   * supplies this because it owns the turn's AbortController; the engine calls
   * it from its crash handler when the run scope is on the stack. Absent means
   * the process exits on an escaped error, which is the CLI's behaviour.
   */
  onRunFault?: ((error: Error, cause: string) => void) | undefined;
  /** Snapshotted from the thread's metadata when the turn starts. */
  systemPrompt?: string;
  disabledTools?: string[];
  /**
   * Where credentials are read from.
   *
   * Passed down rather than constructed here so a server configured with a
   * specific home resolves keys from that home. Absent means the real
   * `~/.reaper/providers.json`, which is right for a normal run and wrong for
   * every test and every embedded server that named its own.
   */
  credentials?: ProviderCredentialStore;
  /**
   * Where user settings are read from, for the disabled-provider list.
   *
   * Threaded for the same reason `credentials` is: a server told to read
   * settings from a specific home must resolve the user's switches from that
   * home, not the real one. Absent means the real `~/.reaper/settings.json`.
   */
  settingsHome?: string;
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
  /**
   * Providers the user switched off, so the implicit fallback skips them the
   * same way the picker withholds them. An explicit thread selection still
   * wins: a thread already pinned to a provider keeps it, and switching that
   * provider off later does not silently move the thread to a different one.
   * Disable is about what a new choice offers, not about rewriting a choice
   * already made.
   */
  disabledProviders: readonly string[] = [],
): { provider: string; model?: string } | undefined {
  if (input.provider) {
    return { provider: input.provider, ...(input.model ? { model: input.model } : {}) };
  }
  return resolveDefaultSelection(credentials, undefined, disabledProviders);
}

/** Creates one fresh engine while reusing the thread's named-session journal. */
export const runManagedTurn: ManagedTurnRunner = async (input) => {
  /*
   * The store the caller provided, or the real one.
   *
   * This used to construct `new ProviderCredentialStore()` unconditionally,
   * which meant the store the app-server was configured with was ignored for
   * every turn: a server told to read credentials from a test home silently
   * read the developer's `~/.reaper/providers.json` instead, and a turn could
   * authenticate as a provider nobody had configured for it.
   *
   * Read once per turn rather than once per process, so a key added in
   * Settings works for the very next turn without a restart. Resolution stays
   * per-profile, so a turn whose fallback lives on a different provider gets
   * that provider's key rather than the primary's.
   */
  const credentials = input.credentials ?? new ProviderCredentialStore();
  /*
   * A thread that names no provider is not a thread that should run on
   * `anthropic` — it is a thread whose provider has not been decided. See
   * `selectTurnModel` and `resolveDefaultSelection` for why falling through to
   * `buildConfig` here made every new chat fail for a user who had configured
   * a different provider.
   */
  const selected = selectTurnModel(
    input,
    credentials,
    readDisabledProviders(input.settingsHome ? { home: input.settingsHome } : {}),
  );
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
      ...(input.filesystemSandbox === false ? { filesystemSandbox: false } : {}),
      ...(input.threadBrowser ? { threadBrowser: input.threadBrowser } : {}),
      ...(input.onRunFault ? { onRunFault: input.onRunFault } : {}),
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
