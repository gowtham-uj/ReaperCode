import { z } from "zod";

export const ModelModalitySchema = z.enum([
  "text",
  "audio",
  "image",
  "video",
  "pdf",
]);

const CostFieldsSchema = z.object({
  input: z.number().finite(),
  output: z.number().finite(),
  cache_read: z.number().finite().optional(),
  cache_write: z.number().finite().optional(),
}).passthrough();

const CostTierSchema = CostFieldsSchema.extend({
  tier: z.object({
    type: z.literal("context"),
    size: z.number().finite(),
  }).passthrough(),
});

export const ModelCostSchema = CostFieldsSchema.extend({
  tiers: z.array(CostTierSchema).optional(),
  context_over_200k: CostFieldsSchema.optional(),
});

export const ModelReasoningOptionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("effort"),
    values: z.array(z.string().nullable()),
  }).passthrough(),
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({
    type: z.literal("budget_tokens"),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  }).passthrough(),
]);

const InterleavedSchema = z.union([
  z.boolean(),
  z.string(),
  z.object({ field: z.string() }).passthrough(),
]);

export const ModelsDevModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  family: z.string().optional(),
  release_date: z.string().default("unknown"),
  last_updated: z.string().optional(),
  knowledge: z.string().optional(),
  attachment: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  temperature: z.boolean().default(false),
  tool_call: z.boolean().default(false),
  structured_output: z.boolean().optional(),
  open_weights: z.boolean().optional(),
  reasoning_options: z.array(ModelReasoningOptionSchema).optional(),
  interleaved: InterleavedSchema.optional(),
  cost: ModelCostSchema.optional(),
  limit: z.object({
    context: z.number().finite().nonnegative().default(0),
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().default(0),
  }).passthrough().default({ context: 0, output: 0 }),
  modalities: z.object({
    input: z.array(ModelModalitySchema),
    output: z.array(ModelModalitySchema),
  }).passthrough().optional(),
  experimental: z.object({
    modes: z.record(z.string(), z.object({
      cost: ModelCostSchema.optional(),
      provider: z.object({
        body: z.record(z.string(), z.unknown()).optional(),
        headers: z.record(z.string(), z.string()).optional(),
      }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
  provider: z.object({
    npm: z.string().optional(),
    api: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

export const ModelsDevProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  env: z.array(z.string().min(1)).default([]),
  npm: z.string().optional(),
  api: z.string().optional(),
  doc: z.string().optional(),
  models: z.record(z.string(), ModelsDevModelSchema),
}).passthrough();

export const ModelsDevCatalogSchema = z.record(z.string(), ModelsDevProviderSchema);

export type ModelsDevCatalog = z.infer<typeof ModelsDevCatalogSchema>;
export type ModelsDevProvider = z.infer<typeof ModelsDevProviderSchema>;
export type ModelsDevModel = z.infer<typeof ModelsDevModelSchema>;
export type ModelReasoningOption = z.infer<typeof ModelReasoningOptionSchema>;
export type ModelCost = z.infer<typeof ModelCostSchema>;
