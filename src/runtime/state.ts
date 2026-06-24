import { z } from "zod";

export const RuntimeStateSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    turnId: z.string().min(1),
    logLevel: z.enum(["info", "debug", "trace"]),
    safetyProfile: z.enum(["allow_all", "standard", "strict"]),
    noticeVerbosity: z.enum(["minimal", "normal", "verbose"]),
    sessionProtocolVersion: z.literal(1),
    userIntentSummary: z.string().min(1),
    tokenBudget: z
      .object({
        softCap: z.number().int().positive(),
        inputTokens: z.number().int().min(0),
        outputTokens: z.number().int().min(0),
      })
      .strict(),
    epicState: z
      .object({
        objectives: z.array(z.string().min(1)),
      })
      .strict(),
    feedback: z.array(z.string()),
    negativeConstraints: z.array(z.string()),
  })
  .strict();

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export function parseRuntimeState(input: unknown): RuntimeState {
  return RuntimeStateSchema.parse(input);
}
