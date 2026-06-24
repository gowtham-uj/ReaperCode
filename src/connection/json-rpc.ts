import { z } from "zod";

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export const JsonRpcNotificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
        data: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.result === undefined && value.error === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON-RPC response must contain either result or error",
      });
    }

    if (value.result !== undefined && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JSON-RPC response cannot contain both result and error",
      });
    }
  });

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export function parseJsonRpcRequest(input: unknown): JsonRpcRequest {
  return JsonRpcRequestSchema.parse(input);
}

export function parseJsonRpcResponse(input: unknown): JsonRpcResponse {
  return JsonRpcResponseSchema.parse(input);
}
