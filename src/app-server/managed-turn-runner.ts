import { buildConfig, buildConfigForProvider } from "../adaptive/exec-runner.js";
import { ConfiguredModelGateway } from "../model/gateway.js";
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
  permissionMode: PermissionMode;
  abortSignal: AbortSignal;
  eventSink: RuntimeEventSink;
  turnControl: RuntimeTurnControl;
  approvalRequester: ToolApprovalRequester;
}

export type ManagedTurnRunner = (input: ManagedTurnRunnerInput) => Promise<RuntimeEngineResult>;

/** Creates one fresh engine while reusing the thread's named-session journal. */
export const runManagedTurn: ManagedTurnRunner = async (input) => {
  const baseConfig = input.provider
    ? buildConfigForProvider({
        workspaceRoot: input.workspaceRoot,
        providerId: input.provider,
        ...(input.model ? { modelId: input.model } : {}),
      })
    : buildConfig({
        workspaceRoot: input.workspaceRoot,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
      });
  const config = withPermissionMode(baseConfig, input.permissionMode);
  const gateway = new ConfiguredModelGateway(config, new ProviderMultiplexerClient());
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
    });
    return await engine.run();
  } finally {
    await gateway.dispose().catch(() => undefined);
  }
};

function withPermissionMode(config: unknown, permissionMode: PermissionMode): unknown {
  const record = asRecord(config) ?? {};
  return {
    ...record,
    runtime: {
      ...(asRecord(record.runtime) ?? {}),
      permissionMode,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
