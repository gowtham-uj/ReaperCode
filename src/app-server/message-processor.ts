import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ZodError } from "zod";

import type { JsonRpcRequest, JsonRpcResponse } from "../connection/json-rpc.js";
import { redactSecrets } from "../logging/redaction.js";
import type { ToolApprovalDecision } from "../tools/approval.js";
import type { AppServerClientConnection } from "./connection.js";
import type { ThreadEventRecord } from "./event-bus.js";
import type { ManagedApprovalRequest } from "./managed-thread.js";
import { ManagedThreadError } from "./managed-thread.js";
import { AppServerOutgoingRouter } from "./outgoing-router.js";
import type { JsonRpcId } from "./protocol.js";
import {
  APP_SERVER_PROTOCOL_VERSION,
  ApprovalResponseResultSchema,
  InitializeParamsSchema,
  ThreadIdParamsSchema,
  ThreadItemsListParamsSchema,
  ThreadListParamsSchema,
  ThreadModelSetParamsSchema,
  ThreadEffortSetParamsSchema,
  ThreadConfigSetParamsSchema,
  ToolsListParamsSchema,
  ThreadNameSetParamsSchema,
  ThreadWorkspaceSetParamsSchema,
  ThreadReadParamsSchema,
  ThreadResumeParamsSchema,
  ThreadStartParamsSchema,
  ThreadTurnsListParamsSchema,
  ThreadUnsubscribeParamsSchema,
  ProviderCredentialRemoveParamsSchema,
  ProviderCredentialSetParamsSchema,
  ProviderListParamsSchema,
  ProviderModelsListParamsSchema,
  ProviderCatalogStatusParamsSchema,
  ProviderCatalogRefreshParamsSchema,
  ProviderAuthCheckParamsSchema,
  ProviderAuthMethodsParamsSchema,
  ProviderAuthApiSetParamsSchema,
  ProviderAuthOAuthStartParamsSchema,
  ProviderAuthOAuthCompleteParamsSchema,
  ProviderAuthOAuthStatusParamsSchema,
  ProviderRemoveParamsSchema,
  MemoryContradictionsParamsSchema,
  MemoryHealthParamsSchema,
  MemoryListParamsSchema,
  MemorySearchParamsSchema,
  PolicyRulesReadParamsSchema,
  PolicyRulesWriteParamsSchema,
  SettingsReadParamsSchema,
  SettingsWriteParamsSchema,
  ThreadPermissionSetParamsSchema,
  TurnInterruptParamsSchema,
  TurnStartParamsSchema,
  TurnSteerParamsSchema,
  WorkspaceExtensionsListParamsSchema,
  WorkspaceSkillsListParamsSchema,
  appServerCapabilities,
  extractTextInput,
  parseAppServerMessage,
} from "./protocol.js";
import { readFilePolicy, writeFilePolicy } from "./file-policy.js";
import { readSettings, writeSettings } from "./settings-surface.js";
import { listAgentTools } from "./tool-inventory.js";
import { listWorkspaceExtensions, listWorkspaceSkills } from "./workspace-inventory.js";
import { ProviderCredentialStore } from "../config/provider-credentials.js";
import { PersistentMemoryStore } from "../adaptive/persistent-memory-store.js";
import type { MemoryRecord } from "../adaptive/types.js";
import { findProviderDescriptor } from "../model/provider/catalog.js";
import { resolveDefaultSelection } from "../model/provider/default-selection.js";
import { ProviderIntegrationRegistry } from "../model/provider/integration-registry.js";
import {
  isReplayStable,
  projectHistory,
  projectThread,
  SessionProjection,
  type ProjectedNotification,
} from "./session-projection.js";
import { ReaperThreadManager, ThreadManagerError } from "./thread-manager.js";

interface ConnectionState {
  initialized: boolean;
  optOutNotificationMethods: Set<string>;
}

export interface AppServerMessageProcessorOptions {
  workspaceRoot: string;
  manager: ReaperThreadManager;
  router: AppServerOutgoingRouter;
  maxConcurrentTurns: number;
  /**
   * Where configured provider API keys live. Injectable so tests get a
   * temporary home instead of writing to the developer's real `~/.reaper`.
   */
  credentials?: ProviderCredentialStore;
  /** Injectable provider/auth registry. Defaults to the deliberately supported
   * production integrations plus the user-global credential store. */
  providers?: ProviderIntegrationRegistry;
  /** User home for universal Settings. Injectable so tests never touch the real home. */
  settingsHome?: string;
  /**
   * Where memory records are read from. Defaults to
   * `<workspaceRoot>/.reaper/memory` (+ `~/.reaper/memory` for user/machine
   * scope). Tests pass a store rooted at a temp dir so a run never reads a
   * developer's real memory.
   */
  memoryStore?: PersistentMemoryStore;
}

export class AppServerMessageProcessor {
  private readonly states = new Map<string, ConnectionState>();
  private readonly turnOwners = new Map<string, string>();
  private readonly projections = new Map<string, SessionProjection>();
  private readonly projectionCache = new Map<string, Map<number, ProjectedNotification[]>>();
  /**
   * Approvals currently shown to a reviewer, keyed by approvalId. Lets the
   * thread's internal timeout/abort paths tell that reviewer the prompt is
   * moot — otherwise the banner stays up forever with no way to distinguish
   * "still waiting" from "expired".
   */
  private readonly outstandingApprovals = new Map<
    string,
    { connectionId: string; requestId: JsonRpcId; threadId: string; turnId: string }
  >();

  /**
   * Lazy so a server that never touches credentials never reads (or creates)
   * `~/.reaper/providers.json`.
   */
  private credentialStore: ProviderCredentialStore | undefined;
  private providerRegistry: ProviderIntegrationRegistry | undefined;

  /**
   * Lazy so a server that never opens the memory browser never reads (or
   * creates) `.reaper/memory/*`. All four `memory/*` RPCs read through this
   * store — nothing here tails the JSONL files directly.
   */
  private memStore: PersistentMemoryStore | undefined;

  constructor(private readonly options: AppServerMessageProcessorOptions) {}

  private get credentials(): ProviderCredentialStore {
    this.credentialStore ??= this.options.credentials ?? new ProviderCredentialStore();
    return this.credentialStore;
  }

  private get providers(): ProviderIntegrationRegistry {
    this.providerRegistry ??= this.options.providers
      ?? new ProviderIntegrationRegistry(undefined, this.credentials);
    return this.providerRegistry;
  }

  private get memory(): PersistentMemoryStore {
    this.memStore ??= this.options.memoryStore
      ?? new PersistentMemoryStore({ workspaceRoot: this.options.workspaceRoot });
    return this.memStore;
  }

  addConnection(connection: AppServerClientConnection): void {
    this.states.set(connection.id, { initialized: false, optOutNotificationMethods: new Set() });
    this.options.router.addConnection(connection);
  }

  removeConnection(connection: AppServerClientConnection): void {
    this.states.delete(connection.id);
    this.options.router.removeConnection(connection.id);
    for (const [key, owner] of this.turnOwners) {
      if (owner === connection.id) this.turnOwners.delete(key);
    }
  }

  async process(connection: AppServerClientConnection, raw: unknown): Promise<void> {
    let message;
    try {
      message = parseAppServerMessage(raw);
    } catch (error) {
      this.options.router.sendError(
        connection.id,
        extractId(raw) ?? "invalid-request",
        -32600,
        "Invalid JSON-RPC message",
        error instanceof ZodError ? { issues: error.issues } : undefined,
      );
      return;
    }

    if (!("method" in message)) {
      if (!this.options.router.resolveResponse(connection.id, message)) {
        this.options.router.sendError(connection.id, message.id, -32600, "Unknown or expired server request ID");
      }
      return;
    }
    if (!("id" in message)) {
      return;
    }

    const state = this.states.get(connection.id);
    if (!state) return;
    if (!state.initialized && message.method !== "initialize") {
      this.options.router.sendError(connection.id, message.id, -32002, "initialize must be the first request");
      return;
    }

    try {
      const result = await this.dispatch(connection, state, message);
      this.options.router.sendResult(connection.id, message.id, result);
      if (message.method === "initialize") {
        this.options.router.sendNotification(connection.id, "initialized", {});
      }
    } catch (error) {
      const mapped = mapError(error);
      this.options.router.sendError(connection.id, message.id, mapped.code, mapped.message, mapped.data);
    }
  }

  async handleApprovalRequest(request: ManagedApprovalRequest): Promise<void> {
    const owner = this.turnOwners.get(turnKey(request.threadId, request.turnId));
    if (!owner) {
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, "cancelled").catch(() => undefined);
      return;
    }
    try {
      const pending = await this.options.router.request(
        owner,
        approvalMethod(request),
        redactSecrets(approvalParams(request)),
        undefined,
        (requestId) => {
          this.outstandingApprovals.set(request.approvalId, {
            connectionId: owner,
            requestId,
            threadId: request.threadId,
            turnId: request.turnId,
          });
        },
      );
      this.outstandingApprovals.delete(request.approvalId);
      const parsed = pending.response.error
        ? "cancelled"
        : ApprovalResponseResultSchema.parse(pending.response.result).decision;
      const decision: ToolApprovalDecision = parsed === "accept" || parsed === "acceptForSession" || parsed === "approved"
        ? "approved"
        : parsed === "decline" || parsed === "denied"
          ? "denied"
          : "cancelled";
      this.sendNotification(owner, "serverRequest/resolved", {
        requestId: pending.requestId,
        threadId: request.threadId,
        turnId: request.turnId,
        decision: parsed,
      });
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, decision);
    } catch {
      this.outstandingApprovals.delete(request.approvalId);
      await this.options.manager.resolveApproval(request.threadId, request.approvalId, "cancelled").catch(() => undefined);
    }
  }

  /**
   * Tell the reviewer that an approval it is still displaying has been settled
   * internally — by the thread's own timeout, or by the turn aborting. Called
   * for every settle path; the ones that came back from the reviewer itself
   * have already been cleared from `outstandingApprovals` and are ignored here.
   */
  handleApprovalSettled(request: ManagedApprovalRequest, decision: ToolApprovalDecision): void {
    const outstanding = this.outstandingApprovals.get(request.approvalId);
    if (!outstanding) return;
    this.outstandingApprovals.delete(request.approvalId);
    this.sendNotification(outstanding.connectionId, "serverRequest/resolved", {
      requestId: outstanding.requestId,
      threadId: outstanding.threadId,
      turnId: outstanding.turnId,
      decision,
    });
  }

  private async dispatch(
    connection: AppServerClientConnection,
    state: ConnectionState,
    request: JsonRpcRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "initialize": {
        if (state.initialized) throw rpcFailure(-32600, "Connection is already initialized");
        const params = InitializeParamsSchema.parse(request.params ?? {});
        state.initialized = true;
        state.optOutNotificationMethods = new Set(params.capabilities.optOutNotificationMethods);
        return {
          protocolVersion: APP_SERVER_PROTOCOL_VERSION,
          serverInfo: { name: "reaper-app-server" },
          capabilities: {
            ...appServerCapabilities,
            maxConcurrentTurns: this.options.maxConcurrentTurns,
          },
          clientInfo: params.clientInfo,
        };
      }
      case "thread/start": {
        const params = ThreadStartParamsSchema.parse(request.params ?? {});
        const provider = params.modelProvider ?? params.provider;
        const userSettings = readSettings(this.options.workspaceRoot, this.options.settingsHome ? { home: this.options.settingsHome } : {});
        // The id is minted here rather than inside `createMetadata` because a
        // thread's own workspace directory is named after it, so the name has
        // to exist before the directory can.
        const threadId = params.threadId ?? randomUUID();
        const explicitRoot = params.cwd ?? params.workspaceRoot;
        const workspaceRoot = explicitRoot
          ? path.resolve(explicitRoot)
          : params.newWorkspace
            ? await createThreadWorkspace(threadId)
            : path.resolve(this.options.workspaceRoot);
        const thread = await this.options.manager.startThread({
          threadId,
          workspaceRoot,
          ...(provider ? { provider } : {}),
          ...(params.model ? { model: params.model } : {}),
          ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
          permissionMode: params.approvalPolicy ?? params.permissionMode ?? userSettings.permissionMode,
          ...(params.title ? { title: params.title } : {}),
        });
        let replay;
        if (params.subscribe) replay = await this.subscribeConnection(connection, thread.threadId, 0);
        return {
          thread: projectThread(thread.metadata, []),
          model: thread.metadata.model ?? null,
          modelProvider: thread.metadata.provider ?? null,
          reasoningEffort: thread.metadata.reasoningEffort ?? "medium",
          cwd: thread.metadata.workspaceRoot,
          approvalPolicy: thread.metadata.permissionMode,
          ...(replay ? { replay } : {}),
        };
      }
      case "thread/resume": {
        const params = ThreadResumeParamsSchema.parse(request.params);
        const thread = await this.options.manager.resumeThread(params.threadId);
        let replay;
        if (params.subscribe) {
          replay = await this.subscribeConnection(connection, params.threadId, params.afterSequence);
        }
        const turns = await this.snapshotTurns(params.threadId);
        const planTodo = await this.snapshotPlanTodo(params.threadId);
        return {
          thread: projectThread(thread.metadata, turns),
          model: thread.metadata.model ?? null,
          modelProvider: thread.metadata.provider ?? null,
          reasoningEffort: thread.metadata.reasoningEffort ?? "medium",
          cwd: thread.metadata.workspaceRoot,
          approvalPolicy: thread.metadata.permissionMode,
          initialTurnsPage: turns,
          ...planTodo,
          ...(replay ? { replay } : {}),
        };
      }
      case "thread/list": {
        const params = ThreadListParamsSchema.parse(request.params ?? {});
        let entries = await this.options.manager.listThreads();
        if (params.searchTerm) {
          entries = entries.filter((entry) => (entry.title ?? "").includes(params.searchTerm!));
        }
        if (params.sortDirection === "asc") entries.reverse();
        const page = paginate(entries, params.cursor, params.limit);
        const data = page.data.map((metadata) => projectThread(metadata));
        return { data, threads: data, nextCursor: page.nextCursor };
      }
      case "thread/read": {
        const params = ThreadReadParamsSchema.parse(request.params);
        const read = await this.options.manager.readThread(params.threadId);
        const turns = params.includeTurns ? await this.snapshotTurns(params.threadId) : undefined;
        const planTodo = await this.snapshotPlanTodo(params.threadId);
        return { thread: projectThread(read.metadata, turns), ...planTodo };
      }
      case "thread/turns/list": {
        const params = ThreadTurnsListParamsSchema.parse(request.params);
        let turns = await this.snapshotTurns(params.threadId);
        if (params.sortDirection === "desc") turns = [...turns].reverse();
        if (params.itemsView === "notLoaded") turns = turns.map((turn) => ({ ...turn, items: [] }));
        const page = paginate(turns, params.cursor, params.limit);
        const planTodo = await this.snapshotPlanTodo(params.threadId);
        return { data: page.data, nextCursor: page.nextCursor, backwardsCursor: null, ...planTodo };
      }
      case "thread/items/list": {
        const params = ThreadItemsListParamsSchema.parse(request.params);
        let turns = await this.snapshotTurns(params.threadId);
        let entries = turns
          .filter((turn) => !params.turnId || turn.id === params.turnId)
          .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })));
        if (params.sortDirection === "desc") entries = [...entries].reverse();
        const page = paginate(entries, params.cursor, params.limit);
        return { data: page.data, nextCursor: page.nextCursor, backwardsCursor: null };
      }
      case "thread/name/set": {
        const params = ThreadNameSetParamsSchema.parse(request.params);
        const metadata = await this.options.manager.setThreadName(params.threadId, params.name);
        this.sendNotification(connection.id, "thread/name/updated", {
          threadId: params.threadId,
          threadName: metadata.title,
        });
        return {};
      }
      case "thread/workspace/set": {
        const params = ThreadWorkspaceSetParamsSchema.parse(request.params);
        const metadata = await this.options.manager.setThreadWorkspace(
          params.threadId,
          params.workspaceRoot,
        );
        const thread = projectThread(metadata);
        /*
         * No notification: `thread/started` is the only message that carries a
         * thread's `cwd`, and it is emitted once per thread. A second client
         * viewing this thread learns about the move when it re-reads the
         * thread, which is also the only time the new path matters — before a
         * turn, the cwd is shown but nothing has been written there yet.
         */
        return { thread, workspaceRoot: thread.cwd };
      }
      case "thread/model/set": {
        const params = ThreadModelSetParamsSchema.parse(request.params);
        const outcome = await this.options.manager.setThreadModel(
          params.threadId,
          params.provider,
          params.model,
        );
        // Notify as well as reply. The result answers the caller, but the
        // notification carries a `threadId`, which is what lets a multiplexer
        // (the BFF) fan it out to every *other* tab on this thread — each of
        // which is still showing the old model in its picker with no other way
        // to learn it changed.
        this.sendNotification(connection.id, "thread/model/updated", {
          threadId: params.threadId,
          provider: outcome.metadata.provider ?? null,
          model: outcome.metadata.model ?? null,
        });
        return {
          thread: projectThread(outcome.metadata),
          model: outcome.metadata.model ?? null,
          modelProvider: outcome.metadata.provider ?? null,
          // Honest about when it bites: a turn already running resolved its
          // profile before this call and keeps it to the end.
          appliesTo: outcome.turnInFlight ? "nextTurn" : "nextRequest",
          turnInFlight: outcome.turnInFlight,
        };
      }
      case "thread/effort/set": {
        const params = ThreadEffortSetParamsSchema.parse(request.params);
        const current = await this.options.manager.readThread(params.threadId);
        const provider = current.metadata.provider;
        const model = current.metadata.model;
        if (!provider || !model || !supportsReasoningEffort(provider, model)) {
          throw rpcFailure(-32602, "The selected model does not expose a reasoning-effort control");
        }
        const outcome = await this.options.manager.setThreadReasoningEffort(
          params.threadId,
          params.reasoningEffort,
        );
        this.sendNotification(connection.id, "thread/effort/updated", {
          threadId: params.threadId,
          reasoningEffort: outcome.metadata.reasoningEffort ?? "medium",
        });
        return {
          thread: projectThread(outcome.metadata),
          reasoningEffort: outcome.metadata.reasoningEffort ?? "medium",
          appliesTo: outcome.turnInFlight ? "nextTurn" : "nextRequest",
          turnInFlight: outcome.turnInFlight,
        };
      }
      case "thread/config/set": {
        const params = ThreadConfigSetParamsSchema.parse(request.params);
        /*
         * `null` clears, omission leaves alone. The schema cannot express that
         * on its own — `systemPrompt?: string | null` gives three states where
         * the manager takes two — so the translation happens here, and the
         * manager's `undefined` means "drop the key".
         */
        let promptInFlight = false;
        if (params.systemPrompt !== undefined) {
          const outcome = await this.options.manager.setThreadSystemPrompt(
            params.threadId,
            params.systemPrompt === null ? undefined : params.systemPrompt,
          );
          promptInFlight = outcome.turnInFlight;
        }
        let toolsInFlight = false;
        if (params.disabledTools !== undefined) {
          const outcome = await this.options.manager.setThreadDisabledTools(
            params.threadId,
            params.disabledTools,
          );
          toolsInFlight = outcome.turnInFlight;
        }
        const read = await this.options.manager.readThread(params.threadId);
        const thread = projectThread(read.metadata);
        /*
         * Both fields are clearable, so a payload that simply omitted one
         * could not be told apart from "this call did not touch it". The
         * notification therefore states both, using `null` and `[]` as the
         * cleared forms — which is also what `thread/model/updated` does with
         * `provider: null` for an unset model.
         */
        this.sendNotification(connection.id, "thread/config/updated", {
          threadId: params.threadId,
          systemPrompt: thread.systemPrompt ?? null,
          disabledTools: thread.disabledTools ?? [],
        });
        return {
          thread,
          systemPrompt: thread.systemPrompt ?? null,
          disabledTools: thread.disabledTools ?? [],
          appliesTo: promptInFlight || toolsInFlight ? "nextTurn" : "nextRequest",
          turnInFlight: promptInFlight || toolsInFlight,
        };
      }
      case "thread/permission/set": {
        const params = ThreadPermissionSetParamsSchema.parse(request.params);
        const outcome = await this.options.manager.setThreadPermissionMode(params.threadId, params.permissionMode);
        this.sendNotification(connection.id, "thread/permission/updated", {
          threadId: params.threadId,
          permissionMode: outcome.metadata.permissionMode,
        });
        return {
          thread: projectThread(outcome.metadata),
          permissionMode: outcome.metadata.permissionMode,
          appliesTo: outcome.turnInFlight ? "nextTurn" : "nextRequest",
          turnInFlight: outcome.turnInFlight,
        };
      }
      case "tools/list": {
        ToolsListParamsSchema.parse(request.params ?? {});
        return { data: listAgentTools() };
      }
      case "workspace/skills/list": {
        const params = WorkspaceSkillsListParamsSchema.parse(request.params ?? {});
        const result = listWorkspaceSkills(this.options.workspaceRoot);
        const data = params.filter
          ? result.data.filter((entry) =>
              entry.name.includes(params.filter!) || entry.description.toLowerCase().includes(params.filter!.toLowerCase()))
          : result.data;
        return { data, errors: result.errors };
      }
      case "workspace/extensions/list": {
        const params = WorkspaceExtensionsListParamsSchema.parse(request.params ?? {});
        const result = listWorkspaceExtensions(this.options.workspaceRoot);
        const data = params.filter
          ? result.data.filter((entry) =>
              entry.id.includes(params.filter!) || entry.description.toLowerCase().includes(params.filter!.toLowerCase()))
          : result.data;
        return { data, errors: result.errors };
      }
      case "settings/read": {
        SettingsReadParamsSchema.parse(request.params ?? {});
        return readSettings(this.options.workspaceRoot, this.options.settingsHome ? { home: this.options.settingsHome } : {});
      }
      case "settings/write": {
        const params = SettingsWriteParamsSchema.parse(request.params);
        const result = writeSettings(
          this.options.workspaceRoot,
          params,
          this.options.settingsHome ? { home: this.options.settingsHome } : {},
        );
        // Permission is a user-wide setting in the browser. Keep every existing
        // thread in sync so switching conversations cannot silently restore an
        // older per-thread mode; new threads read this same default above.
        if (params.permissionMode !== undefined) {
          const threads = await this.options.manager.listThreads();
          await Promise.all(threads.map(async (thread) => {
            const outcome = await this.options.manager.setThreadPermissionMode(
              thread.threadId,
              params.permissionMode!,
            );
            this.sendNotification(connection.id, "thread/permission/updated", {
              threadId: thread.threadId,
              permissionMode: outcome.metadata.permissionMode,
            });
          }));
        }
        return result;
      }
      case "policy/rules/read": {
        PolicyRulesReadParamsSchema.parse(request.params ?? {});
        return await readFilePolicy(this.options.workspaceRoot);
      }
      case "policy/rules/write": {
        const params = PolicyRulesWriteParamsSchema.parse(request.params);
        return await writeFilePolicy(this.options.workspaceRoot, params.rules);
      }
      case "provider/list": {
        ProviderListParamsSchema.parse(request.params ?? {});
        /*
         * `defaultSelection` is what a turn will actually run on when neither
         * the thread nor Settings names a model — the same value the turn path
         * resolves, computed here so the composer can show it. Without it the
         * picker read "Choose model" while a turn was quietly running on the
         * user's configured provider, which is the UI claiming nothing is
         * selected when something is.
         *
         * It is derived from the credential store, so it carries a provider id
         * and a catalog model id and no part of any credential.
         */
        return {
          providers: this.providers.list(),
          defaultSelection: resolveDefaultSelection(this.credentials) ?? null,
        };
      }
      case "provider/models/list": {
        const params = ProviderModelsListParamsSchema.parse(request.params);
        return this.providers.listModels(params);
      }
      case "provider/catalog/status": {
        ProviderCatalogStatusParamsSchema.parse(request.params ?? {});
        return this.providers.catalogStatus();
      }
      case "provider/catalog/refresh": {
        const params = ProviderCatalogRefreshParamsSchema.parse(request.params ?? {});
        return await this.providers.refreshCatalog(params.force);
      }
      case "provider/auth/methods": {
        const params = ProviderAuthMethodsParamsSchema.parse(request.params);
        return { methods: this.providers.methods(params.providerId) };
      }
      case "provider/auth/api/set": {
        const params = ProviderAuthApiSetParamsSchema.parse(request.params);
        const provider = await this.providers.connectApi({
          providerId: params.providerId,
          methodId: params.methodId,
          key: params.apiKey,
          ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
          ...(params.inputs ? { inputs: params.inputs } : {}),
        });
        // Verify the key the user just entered rather than reporting success
        // for anything that merely persisted. The credential is still stored
        // on a failed check so the user can correct it without re-typing.
        const health = await this.providers.checkHealth(params.providerId);
        return { provider, health };
      }
      case "provider/auth/check": {
        const params = ProviderAuthCheckParamsSchema.parse(request.params);
        return { health: await this.providers.checkHealth(params.providerId) };
      }
      case "provider/auth/oauth/start": {
        const params = ProviderAuthOAuthStartParamsSchema.parse(request.params);
        const attempt = await this.providers.beginOAuth({
          providerId: params.providerId,
          methodId: params.methodId,
          ...(params.inputs ? { inputs: params.inputs } : {}),
        });
        return { attempt };
      }
      case "provider/auth/oauth/complete": {
        const params = ProviderAuthOAuthCompleteParamsSchema.parse(request.params);
        return await this.providers.completeOAuth({
          attemptId: params.attemptId,
          ...(params.code ? { code: params.code } : {}),
        });
      }
      case "provider/auth/oauth/status": {
        const params = ProviderAuthOAuthStatusParamsSchema.parse(request.params);
        return await this.providers.oauthStatus(params.attemptId);
      }
      case "provider/remove": {
        const params = ProviderRemoveParamsSchema.parse(request.params);
        return this.providers.remove(params.providerId);
      }
      case "model/catalog": {
        // Compatibility alias. Models are intentionally loaded through the
        // bounded provider/models/list method rather than embedded here.
        return { providers: this.providers.list() };
      }
      case "provider/credentials/list": {
        return { credentials: this.credentials.list() };
      }
      case "provider/credentials/set": {
        const params = ProviderCredentialSetParamsSchema.parse(request.params);
        const descriptor = findProviderDescriptor(params.providerId);
        const method = this.providers.methods(params.providerId).find((candidate) => candidate.type === "api");
        if (!descriptor || !method) {
          throw rpcFailure(-32602, `Unsupported provider \"${params.providerId}\"`);
        }
        const provider = await this.providers.connectApi({
          providerId: params.providerId,
          methodId: method.id,
          key: params.apiKey,
          ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
        });
        const credential = this.credentials.list().find((entry) => entry.providerId === params.providerId);
        return { credential, provider };
      }
      case "provider/credentials/remove": {
        const params = ProviderCredentialRemoveParamsSchema.parse(request.params);
        const outcome = this.providers.remove(params.providerId);
        return { removed: outcome.removed, credentials: this.credentials.list() };
      }
      case "memory/list": {
        const params = MemoryListParamsSchema.parse(request.params ?? {});
        const merged = params.scopes.flatMap((scope) => this.memory.list(scope));
        merged.sort((a, b) => params.sortDirection === "asc"
          ? a.updatedAt.localeCompare(b.updatedAt)
          : b.updatedAt.localeCompare(a.updatedAt));
        const page = paginate(merged.map(toWireRecord), params.cursor, params.limit);
        return { data: page.data, nextCursor: page.nextCursor };
      }
      case "memory/search": {
        const params = MemorySearchParamsSchema.parse(request.params);
        const results = this.memory.search(params.query, params.scopes);
        const page = paginate(results.map(toWireRecord), params.cursor, params.limit);
        return { data: page.data, nextCursor: page.nextCursor, query: params.query };
      }
      case "memory/health": {
        MemoryHealthParamsSchema.parse(request.params ?? {});
        return { ...this.memory.healthCheck(), loadErrors: this.memory.getLoadErrors() };
      }
      case "memory/contradictions": {
        MemoryContradictionsParamsSchema.parse(request.params ?? {});
        const pairs = this.memory.detectContradictions();
        return {
          data: pairs.map((pair) => ({
            a: toWireRecord(pair.a),
            b: toWireRecord(pair.b),
            reason: pair.reason,
          })),
        };
      }
      case "thread/unsubscribe": {
        const params = ThreadUnsubscribeParamsSchema.parse(request.params);
        connection.subscriptions.get(params.threadId)?.();
        connection.subscriptions.delete(params.threadId);
        return { unsubscribed: true };
      }
      case "thread/close": {
        const params = ThreadIdParamsSchema.parse(request.params);
        await this.options.manager.closeThread(params.threadId);
        return { closed: true };
      }
      case "thread/loaded/list": {
        ThreadListParamsSchema.parse(request.params ?? {});
        const loaded = (await this.options.manager.listThreads())
          .filter((metadata) => this.options.manager.peekThread(metadata.threadId))
          .map((metadata) => metadata.threadId);
        return { data: loaded, threadIds: loaded };
      }
      case "turn/start": {
        const params = TurnStartParamsSchema.parse(request.params);
        const prompt = extractTextInput(params);
        const turnId = params.turnId ?? `turn-${randomUUID()}`;
        const key = turnKey(params.threadId, turnId);
        this.turnOwners.set(key, connection.id);
        try {
          const handle = await this.options.manager.startTurn(params.threadId, {
            prompt,
            turnId,
          });
          void handle.completion.finally(() => {
            if (this.turnOwners.get(key) === connection.id) this.turnOwners.delete(key);
          });
          return {
            threadId: params.threadId,
            turnId: handle.turnId,
            accepted: true,
            turn: { id: handle.turnId, status: "inProgress", items: [] },
          };
        } catch (error) {
          this.turnOwners.delete(key);
          throw error;
        }
      }
      case "turn/interrupt": {
        const params = TurnInterruptParamsSchema.parse(request.params);
        const interrupted = await this.options.manager.interruptTurn(params.threadId, params.turnId);
        return { interrupted };
      }
      case "turn/steer": {
        const params = TurnSteerParamsSchema.parse(request.params);
        const turnId = params.expectedTurnId ?? params.turnId;
        if (!turnId) throw rpcFailure(-32602, "turn/steer requires turnId or expectedTurnId");
        return await this.options.manager.steerTurn(params.threadId, turnId, extractTextInput(params));
      }
      default:
        throw rpcFailure(-32601, `Method not found: ${request.method}`);
    }
  }

  private async snapshotTurns(threadId: string) {
    let projection = this.projections.get(threadId);
    if (!projection) {
      projection = new SessionProjection();
      this.projections.set(threadId, projection);
    }
    const read = await this.options.manager.readThread(threadId);
    projection.hydrate(projectHistory(read.messages));
    return projection.snapshotTurns();
  }

  /** Plan + todo checklists, or undefined when the agent has produced none. */
  private async snapshotPlanTodo(threadId: string): Promise<{ plan?: unknown; todo?: unknown }> {
    const projection = this.projections.get(threadId);
    if (!projection) return {};
    return {
      ...(projection.snapshotPlan() !== undefined ? { plan: projection.snapshotPlan() } : {}),
      ...(projection.snapshotTodo() !== undefined ? { todo: projection.snapshotTodo() } : {}),
      ...(projection.snapshotVerification() !== undefined
        ? { verification: projection.snapshotVerification() }
        : {}),
    };
  }

  private async subscribeConnection(
    connection: AppServerClientConnection,
    threadId: string,
    afterSequence: number,
  ): Promise<{ earliestSequence: number; latestSequence: number; truncated: boolean }> {
    await this.snapshotTurns(threadId).catch(() => undefined);
    connection.subscriptions.get(threadId)?.();
    const buffered: ThreadEventRecord[] = [];
    let replaying = true;
    const subscription = await this.options.manager.subscribe(
      threadId,
      connection.id,
      (event) => {
        if (replaying) buffered.push(event);
        else this.sendThreadEvent(connection.id, event);
      },
      afterSequence,
    );
    connection.subscriptions.set(threadId, subscription.unsubscribe);
    for (const event of subscription.replay.events) this.sendThreadEvent(connection.id, event);
    replaying = false;
    for (const event of buffered) {
      if (event.sequence > subscription.replay.latestSequence) this.sendThreadEvent(connection.id, event);
    }
    if (subscription.replay.truncated) {
      this.options.router.sendNotification(connection.id, "warning", {
        threadId,
        code: "replay_truncated",
        message: "The requested replay offset is older than the in-memory replay window. Use thread/read for persisted conversation history.",
        earliestSequence: subscription.replay.earliestSequence,
      });
    }
    return {
      earliestSequence: subscription.replay.earliestSequence,
      latestSequence: subscription.replay.latestSequence,
      truncated: subscription.replay.truncated,
    };
  }

  private sendThreadEvent(connectionId: string, record: ThreadEventRecord): void {
    let threadCache = this.projectionCache.get(record.threadId);
    if (!threadCache) {
      threadCache = new Map();
      this.projectionCache.set(record.threadId, threadCache);
    }
    let notifications = threadCache.get(record.sequence);
    if (!notifications) {
      let projection = this.projections.get(record.threadId);
      if (!projection) {
        projection = new SessionProjection();
        this.projections.set(record.threadId, projection);
      }
      notifications = projection.project(record, this.options.manager.peekThread(record.threadId)?.metadata);
      /*
       * `thread.started` is the one projection that reads live thread metadata
       * rather than only the record, so it is the one projection whose value
       * changes after the event was recorded. Caching it would freeze a replay
       * at creation-time settings — a thread configured mid-conversation would
       * come back to a reconnecting client with the configuration stripped.
       */
      if (isReplayStable(notifications)) {
        threadCache.set(record.sequence, notifications);
        while (threadCache.size > 2_000) {
          const oldest = threadCache.keys().next().value as number | undefined;
          if (oldest === undefined) break;
          threadCache.delete(oldest);
        }
      }
    }
    for (const notification of notifications) {
      this.sendNotification(connectionId, notification.method, notification.params);
    }
  }

  private sendNotification(connectionId: string, method: string, params: unknown): boolean {
    if (this.states.get(connectionId)?.optOutNotificationMethods.has(method)) return true;
    return this.options.router.sendNotification(connectionId, method, params);
  }
}

function approvalParams(request: ManagedApprovalRequest): Record<string, unknown> {
  const common = {
    threadId: request.threadId,
    turnId: request.turnId,
    approvalId: request.approvalId,
    itemId: request.toolCall.id,
    reason: request.reason,
    ...(request.ruleMatch ? { ruleMatch: request.ruleMatch } : {}),
  };
  if (request.toolCall.name === "bash") {
    return {
      ...common,
      command: "cmd" in (request.toolCall.args as object) && typeof (request.toolCall.args as { cmd?: unknown }).cmd === "string"
        ? (request.toolCall.args as { cmd: string }).cmd
        : "",
      cwd: request.workingDirectory,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
  }
  if (["write_file", "edit_file", "file_edit", "apply_patch", "delete_file"].includes(request.toolCall.name)) {
    return {
      ...common,
      grantRoot: request.workspaceRoot,
      changes: request.toolCall.args,
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    };
  }
  return {
    ...common,
    tool: request.toolCall.name,
    arguments: request.toolCall.args as Record<string, unknown>,
    availableDecisions: ["accept", "decline", "cancel"],
  };
}

function approvalMethod(request: ManagedApprovalRequest): string {
  if (request.toolCall.name === "bash") return "item/commandExecution/requestApproval";
  if (["write_file", "edit_file", "file_edit", "apply_patch"].includes(request.toolCall.name)) {
    return "item/fileChange/requestApproval";
  }
  return "item/tool/requestApproval";
}

/**
 * Create the workspace directory a self-contained thread owns.
 *
 * Under the user's home, not the server's workspace: a thread nested inside
 * the agent's own checkout would appear in that checkout's git status and file
 * tree, which is exactly the confusion this separation exists to remove.
 *
 * The id has already been validated as a thread id (`ThreadIdSchema`, or a
 * freshly minted UUID), so it cannot contain a separator or `..` — but it is
 * re-checked here because this is the function that turns it into a path.
 */
async function createThreadWorkspace(threadId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(threadId) || threadId === "." || threadId === "..") {
    throw rpcFailure(-32602, `Invalid thread id: ${threadId}`);
  }
  const root = path.join(homedir(), ".reaper", "workspaces", threadId);
  await mkdir(root, { recursive: true, mode: 0o700 });

  /*
   * The Diff tab reads a repo in *this* thread's directory, and without one
   * `git` walks up to the nearest ancestor repository — so a workspace placed
   * under an existing checkout would answer with that repository's diff, the
   * same "showing files that aren't yours" confusion this separation exists to
   * remove.
   *
   * Deliberately NOT satisfied by running `git init` here, which is what this
   * used to do. Initializing the directory pre-empts the most normal thing a
   * user does with an empty thread folder — `git clone <url> .` — because git
   * refuses to clone into a directory that already holds a repository
   * ("destination path '.' already exists and is not an empty directory").
   * The thread then cannot hold a real project no matter what the user asks
   * for, and the failure looks like the clone's fault rather than ours.
   *
   * So the repo is created lazily instead, by `gitDiff`/`gitStatus` at the
   * moment something asks for a diff — by which point an empty directory that
   * is still empty is unambiguous evidence that no clone is coming, and a
   * directory holding a cloned repo is left alone because it already answers
   * the question. Best-effort throughout: a thread whose workspace has no repo
   * still works for everything except the Diff tab.
   */
  return root;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function extractId(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/**
 * Defense in depth on top of the store's own redaction: `remember`/`update`
 * already scrub `content` for `sensitive: true` records, but `evidence` is not
 * scrubbed by the store. Strip it here so a sensitive record's evidence excerpt
 * never leaves the process, without re-deciding what "sensitive" means — that
 * decision stays entirely in PersistentMemoryStore.
 */
function toWireRecord(record: MemoryRecord): MemoryRecord {
  if (!record.sensitive) return record;
  return { ...record, evidence: [] };
}

function supportsReasoningEffort(provider: string, model: string): boolean {
  if (provider !== "openai") return false;
  const normalized = model.toLowerCase().replace(/^openai\//, "");
  return /^o\d/.test(normalized) || /^gpt-(?:5|[6-9])/.test(normalized);
}

function rpcFailure(code: number, message: string, data?: unknown): Error & { code: number; data?: unknown } {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

function paginate<T>(data: T[], cursor: string | undefined, limit: number): { data: T[]; nextCursor: string | null } {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw rpcFailure(-32602, "Invalid pagination cursor");
  const page = data.slice(offset, offset + limit);
  const next = offset + page.length;
  return { data: page, nextCursor: next < data.length ? String(next) : null };
}

function mapError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof ZodError) return { code: -32602, message: "Invalid method parameters", data: { issues: error.issues } };
  if (error instanceof ThreadManagerError) {
    return { code: error.code === "thread_not_found" ? -32004 : -32003, message: error.message, data: { reason: error.code } };
  }
  if (error instanceof ManagedThreadError) {
    return { code: error.code === "turn_in_progress" ? -32010 : -32011, message: error.message, data: { reason: error.code } };
  }
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "number") {
    return {
      code: (error as Error & { code: number }).code,
      message: error.message,
      ...("data" in error ? { data: (error as Error & { data?: unknown }).data } : {}),
    };
  }
  return { code: -32603, message: error instanceof Error ? error.message : "Internal server error" };
}
