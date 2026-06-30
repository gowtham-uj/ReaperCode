import { z } from "zod";

export const AttachmentReferenceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const ArtifactReferenceSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.enum(["tool_output", "verification_log", "attachment"]),
  })
  .strict();

export const RequestReferencesSchema = z
  .object({
    attachments: z.array(AttachmentReferenceSchema).optional(),
    artifactRefs: z.array(ArtifactReferenceSchema).optional(),
  })
  .strict();

export type AttachmentReference = z.infer<typeof AttachmentReferenceSchema>;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;
export type RequestReferences = z.infer<typeof RequestReferencesSchema>;

export function parseRequestReferences(input: unknown): RequestReferences {
  return RequestReferencesSchema.parse(input);
}
