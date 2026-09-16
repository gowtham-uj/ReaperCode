import { z } from "zod";

import { JsonRpcIdSchema, JsonRpcNotificationSchema, JsonRpcRequestSchema, JsonRpcResponseSchema } from "../connection/json-rpc.js";

export const APP_SERVER_PROTOCOL_VERSION = 1 as const;

const ThreadIdSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const NonNegativeSequenceSchema = z.number().int().nonnegative();
const PermissionModeSchema = z.enum(["yolo", "accept_edits", "auto", "strict"]);
const ReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export const InitializeParamsSchema = z.object({
  protocolVersion: z.literal(APP_SERVER_PROTOCOL_VERSION).default(APP_SERVER_PROTOCOL_VERSION),
  clientInfo: z.object({
    name: z.string().min(1),
    title: z.string().optional(),
    version: z.string().optional(),
  }).optional(),
  capabilities: z.object({
    experimentalApi: z.boolean().default(false),
    optOutNotificationMethods: z.array(z.string().min(1)).max(256).default([]),
  }).default({ experimentalApi: false, optOutNotificationMethods: [] }),
}).strict();

export const ThreadStartParamsSchema = z.object({
  threadId: ThreadIdSchema.optional(),
  workspaceRoot: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  /**
   * Give this thread its own empty workspace directory instead of the server's.
   *
   * Opt-in rather than the default: every existing caller — the CLI, the test
   * fixtures — starts a thread meaning "work on the directory I am in", and
   * silently relocating them would change what those threads operate on. The
   * web UI opts in, because a chat thread there is a project of its own.
   *
   * Ignored when `cwd` or `workspaceRoot` names a directory explicitly; those
   * are the more specific request.
   */
  newWorkspace: z.boolean().default(false),
  provider: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  approvalPolicy: PermissionModeSchema.optional(),
  title: z.string().max(500).optional(),
  ephemeral: z.boolean().default(false),
  subscribe: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  if (value.ephemeral) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ephemeral threads are not supported" });
});

export const ThreadResumeParamsSchema = z.object({
  threadId: ThreadIdSchema,
  afterSequence: NonNegativeSequenceSchema.default(0),
  subscribe: z.boolean().default(true),
}).strict();

export const ThreadIdParamsSchema = z.object({ threadId: ThreadIdSchema }).strict();
export const ThreadReadParamsSchema = z.object({
  threadId: ThreadIdSchema,
  includeTurns: z.boolean().default(false),
}).strict();
export const ThreadListParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  searchTerm: z.string().optional(),
}).strict();
export const ThreadTurnsListParamsSchema = z.object({
  threadId: ThreadIdSchema,
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  itemsView: z.enum(["notLoaded", "summary", "full"]).default("summary"),
}).strict();
export const ThreadItemsListParamsSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
}).strict();
export const ThreadNameSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  name: z.string().min(1).max(500),
}).strict();
/**
 * Move a thread's workspace.
 *
 * Only accepted for a thread that has not run a turn; the app-server refuses
 * with `turn_in_progress` otherwise, because the workspace is part of the
 * transcript's address rather than a plain setting.
 */
export const ThreadWorkspaceSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  workspaceRoot: z.string().min(1).max(4096),
}).strict();
export const ThreadUnsubscribeParamsSchema = z.object({ threadId: ThreadIdSchema }).strict();

/**
 * Switch a thread's model.
 *
 * Takes effect at the next model request, not immediately: a turn already in
 * flight has a resolved profile in hand and may be mid-stream. Applying a swap
 * underneath it would mean one turn's transcript was produced by two different
 * models with nothing recording where the seam was. The result reports
 * `appliesTo` so the client can say which, rather than implying instant effect.
 */
export const ThreadModelSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(200),
}).strict();

/**
 * Change the reasoning effort used by a thread's next supported model request.
 * The processor rejects this for models that do not expose a real effort knob,
 * so the browser never presents a cosmetic control.
 */
export const ThreadEffortSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  reasoningEffort: ReasoningEffortSchema,
}).strict();

/**
 * Per-thread agent configuration.
 *
 * Every field is optional so a caller changes only what it names. The null
 * forms are deliberate and distinct from omission: `systemPrompt: null` clears
 * the thread's instructions, which a caller cannot express by leaving the key
 * out, and `disabledTools: []` re-enables every tool.
 */
export const ThreadConfigSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  systemPrompt: z.string().max(20_000).nullable().optional(),
  disabledTools: z.array(z.string().min(1).max(128)).max(200).optional(),
  filesystemSandbox: z.boolean().optional(),
}).strict();

/**
 * The tool names a thread's agent could call.
 *
 * Read from the same registry the model's tool schemas are built from, so the
 * settings UI can only ever offer switches for tools that actually exist —
 * a hand-maintained list would drift the moment a tool is added, and a toggle
 * for a nonexistent name silently stores a no-op.
 */
export const ToolsListParamsSchema = z.object({}).strict();

/**
 * Credential writes. `apiKey` is inbound-only — no response schema in this
 * file ever carries it back, and `ProviderCredentialStore.list()` is the only
 * shape sent to a client.
 */
export const ProviderCredentialSetParamsSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  apiKey: z.string().min(1).max(500),
  baseUrl: z.string().url().max(500).optional(),
}).strict();

export const ProviderCredentialRemoveParamsSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
}).strict();

const ProviderIdParamSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const ProviderMethodIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);
const ProviderAuthInputsSchema = z.record(z.string().min(1).max(100), z.string().max(2_000));

/** Provider integration surface. Provider hooks stay in the app-server;
 * browser calls carry only method ids, prompt input, opaque OAuth attempt ids,
 * and inbound-only secrets. */
export const ProviderListParamsSchema = z.object({}).strict();
export const ProviderModelsListParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
  query: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  status: z.enum(["active", "alpha", "beta", "deprecated"]).optional(),
  reasoning: z.boolean().optional(),
  attachments: z.boolean().optional(),
  toolCalls: z.boolean().optional(),
}).strict();
export const ProviderCatalogStatusParamsSchema = z.object({}).strict();
export const ProviderCatalogRefreshParamsSchema = z.object({
  force: z.boolean().default(true),
}).strict();
export const ProviderAuthMethodsParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
}).strict();
export const ProviderAuthCheckParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
}).strict();
export const ProviderAuthApiSetParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
  methodId: ProviderMethodIdSchema,
  apiKey: z.string().min(1).max(4_000),
  baseUrl: z.string().url().max(500).optional(),
  inputs: ProviderAuthInputsSchema.optional(),
}).strict();
export const ProviderAuthOAuthStartParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
  methodId: ProviderMethodIdSchema,
  inputs: ProviderAuthInputsSchema.optional(),
}).strict();
export const ProviderAuthOAuthCompleteParamsSchema = z.object({
  attemptId: z.string().uuid(),
  code: z.string().min(1).max(4_000).optional(),
}).strict();
export const ProviderAuthOAuthStatusParamsSchema = z.object({
  attemptId: z.string().uuid(),
}).strict();
export const ProviderRemoveParamsSchema = z.object({
  providerId: ProviderIdParamSchema,
}).strict();

/**
 * Read-only memory browser. The `secret` scope is excluded at the schema layer
 * — a client can never even ask for it, on top of PersistentMemoryStore already
 * refusing to store it. Every record returned has passed through the store's
 * own redaction (and the processor's evidence strip for sensitive records).
 */
const MemoryScopeParamSchema = z.enum(["transient", "project", "user", "machine"]);

export const MemoryListParamsSchema = z.object({
  scopes: z.array(MemoryScopeParamSchema).min(1).max(4)
    .default(["transient", "project", "user", "machine"]),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
}).strict();

export const MemorySearchParamsSchema = z.object({
  query: z.string().min(1).max(500),
  scopes: z.array(MemoryScopeParamSchema).min(1).max(4)
    .default(["transient", "project", "user", "machine"]),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

export const MemoryHealthParamsSchema = z.object({}).strict();

export const MemoryContradictionsParamsSchema = z.object({}).strict();

/**
 * Read-only workspace inventory. Both lists answer the same question — "what
 * can this agent do, and how much do I trust each of those things?" — so they
 * share one shape. Nothing here activates or loads an extension's main; the
 * only inbound knob later phases add is `filter`.
 */
const WorkspaceListParamsSchema = z.object({
  filter: z.string().min(1).max(200).optional(),
}).strict();
export const WorkspaceSkillsListParamsSchema = WorkspaceListParamsSchema;
export const WorkspaceExtensionsListParamsSchema = WorkspaceListParamsSchema;

/**
 * Settings read + the one narrow write we support. `settings/read` returns an
 * allowlisted summary — never the raw config object, which could carry keys
 * this schema does not know and must never cross the wire.
 */
export const SettingsReadParamsSchema = z.object({}).strict();

const SettingsPermissionModeSchema = PermissionModeSchema;
export const SettingsWriteParamsSchema = z.object({
  permissionMode: SettingsPermissionModeSchema.optional(),
  modelRouting: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).optional(),
  thinking: z.object({ enabled: z.boolean() }).strict().optional(),
  /**
   * Always-on skills, replaced wholesale.
   *
   * Bounded at both ends: 50 names of 200 characters each is the most a client
   * can ask the server to put in front of the model on every future turn. The
   * names are *references*, not content — the body is resolved server-side
   * against skills that already passed the project-trust gate, so this field
   * cannot be used to inject text into a prompt.
   */
  pinnedSkills: z.array(z.string().min(1).max(200)).max(50).optional(),
  /**
   * Switched-off skills, replaced wholesale.
   *
   * Same shape and the same reasoning as `pinnedSkills`, and the same guarantee:
   * these are *names*, resolved server-side against skills that already passed
   * the trust gate. Nothing here can put text into a prompt. The cap is higher
   * because switching a skill off removes cost rather than adding it — a user
   * may reasonably want most of a large library out of the way.
   */
  disabledSkills: z.array(z.string().min(1).max(200)).max(500).optional(),
  /**
   * Providers switched off, replaced wholesale. Kept separate from
   * `disabledSkills` because a skill name and a provider id resolve against
   * different registries and a shared list would let one shadow the other.
   */
  disabledProviders: z.array(z.string().min(1).max(200)).max(500).optional(),
}).strict().refine((value) =>
  value.permissionMode !== undefined || value.modelRouting !== undefined
  || value.thinking !== undefined || value.pinnedSkills !== undefined
  || value.disabledSkills !== undefined || value.disabledProviders !== undefined,
{ message: "settings/write requires at least one change" });

/** Per-thread permission mode. Mirrors thread/model/set: applies to the next
 *  turn, not the running one. */
export const ThreadPermissionSetParamsSchema = z.object({
  threadId: ThreadIdSchema,
  permissionMode: PermissionModeSchema,
}).strict();

/** File policy: replace the `rules.local.md` allow/deny block. */
const FilePolicyRuleSchema = z.object({
  outcome: z.enum(["allow", "deny"]),
  pattern: z.string().min(1).max(2_000),
}).strict();
export const PolicyRulesReadParamsSchema = z.object({}).strict();
export const PolicyRulesWriteParamsSchema = z.object({
  rules: z.array(FilePolicyRuleSchema).max(500),
}).strict();

const TextInputSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
}).strict();

export function extractTextInput(value: {
  prompt?: string | undefined;
  message?: string | undefined;
  input?: Array<{ type: "text"; text: string }> | undefined;
}): string {
  if (value.prompt?.trim()) return value.prompt.trim();
  if (value.message?.trim()) return value.message.trim();
  return (value.input ?? []).map((item) => item.text).join("\n").trim();
}

export const TurnStartParamsSchema = z.object({
  threadId: ThreadIdSchema,
  prompt: z.string().min(1).optional(),
  input: z.array(TextInputSchema).min(1).optional(),
  turnId: z.string().min(1).max(256).optional(),
}).strict().superRefine((value, ctx) => {
  if (!extractTextInput(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "turn/start requires prompt or input" });
  }
});

export const TurnInterruptParamsSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: z.string().min(1).max(256).optional(),
}).strict();

export const TurnSteerParamsSchema = z.object({
  threadId: ThreadIdSchema,
  turnId: z.string().min(1).max(256).optional(),
  expectedTurnId: z.string().min(1).max(256).optional(),
  message: z.string().min(1).optional(),
  input: z.array(TextInputSchema).min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (!extractTextInput(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "turn/steer requires message or input" });
  }
});

export const ApprovalResponseResultSchema = z.object({
  decision: z.enum([
    "approved", "denied", "cancelled",
    "accept", "acceptForSession", "decline", "cancel",
  ]),
}).strict();

export type AppServerIncomingMessage =
  | z.infer<typeof JsonRpcRequestSchema>
  | z.infer<typeof JsonRpcNotificationSchema>
  | z.infer<typeof JsonRpcResponseSchema>;

export function parseAppServerMessage(value: unknown): AppServerIncomingMessage {
  const response = JsonRpcResponseSchema.safeParse(value);
  if (response.success) return response.data;
  const request = JsonRpcRequestSchema.safeParse(value);
  if (request.success) return request.data;
  return JsonRpcNotificationSchema.parse(value);
}

export const appServerCapabilities = {
  streaming: true,
  assistantMessageDeltas: true,
  reasoningDeltas: true,
  commandOutputDeltas: true,
  approvals: true,
  interrupt: true,
  steering: true,
  steeringGranularity: "model_loop_boundary",
  threadResume: true,
  boundedReplay: true,
  multipleSubscribers: true,
  disconnectDoesNotAbort: true,
  threadTurnsList: true,
  threadItemsList: true,
  itemStartedCompleted: true,
} as const;

export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
