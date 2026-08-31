import { z } from "zod";

import { JsonRpcIdSchema, JsonRpcNotificationSchema, JsonRpcRequestSchema, JsonRpcResponseSchema } from "../connection/json-rpc.js";

export const APP_SERVER_PROTOCOL_VERSION = 1 as const;

const ThreadIdSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/);
const NonNegativeSequenceSchema = z.number().int().nonnegative();
const PermissionModeSchema = z.enum(["yolo", "accept_edits", "auto", "strict"]);

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
  provider: z.string().min(1).optional(),
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  permissionMode: PermissionModeSchema.default("accept_edits"),
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
export const ThreadUnsubscribeParamsSchema = z.object({ threadId: ThreadIdSchema }).strict();

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
