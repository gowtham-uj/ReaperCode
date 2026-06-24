import { z } from "zod";

export const SubTaskContractSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    prompt: z.string().min(1),
    verificationCommand: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([]),
    files: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type SubTaskContract = z.infer<typeof SubTaskContractSchema>;

export function parseSubTaskContracts(input: unknown): SubTaskContract[] {
  return z.array(SubTaskContractSchema).min(1).parse(input);
}
