/**
 * Zod schemas for extension authoring, now a single model-callable tool.
 *
 *   extension_manager(action="create")     author a new extension (JS only)
 *   extension_manager(action="list")       inventory, incl. refused registrations
 *   extension_manager(action="validate")   run validation.commands
 *   extension_manager(action="enable")     activate the extension
 *   extension_manager(action="trust")      record a trust decision (no tiers)
 *   extension_manager(action="uninstall")  remove (gated)
 *
 * There is no `reload` action. The registry re-walks the disk on every
 * state-changing call and after an install that lands files outside this
 * tool, so a separate reload step was a step the model could forget and
 * whose absence looked like a bug.
 */

import { z } from "zod";

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

const PERMISSIONS = [
  "tools:read",
  "tools:write_file",
  "tools:edit_file",
  "tools:delete_file",
  "tools:bash",
  "tools:network",
  "shell:low",
  "shell:medium",
  "shell:high",
  "memory:project:read",
  "memory:project:write",
  "memory:user:read",
  "memory:user:write",
  "session:read",
  "session:write",
] as const;

const MAX_SOURCE_BYTES = 64 * 1024;

export const CreateExtensionArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX, "id must match kebab-case"),
    version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver"),
    description: z.string().min(1).max(240),
    /** Path relative to the extension root. Default "main.js". */
    main: z.string().min(1).default("main.js"),
    engines_reaper: z.string().regex(/^[\^~]?\d+\.\d+\.\d+/, "engines.reaper must be a semver range").default("^1.0.0"),
    permissions: z.array(z.enum(PERMISSIONS)).default([]),
    /** JS source for main.js. Required (extensions are JS only). */
    source: z.string().min(1).max(MAX_SOURCE_BYTES),
    tools: z
      .array(
        z.object({
          name: z.string().min(1),
          description: z.string().min(1),
          schema: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
    hooks_declared: z
      .array(z.object({ event: z.string().min(1), timeout_ms: z.number().int().positive().optional() }))
      .optional(),
    slash_commands: z.array(z.object({ name: z.string().min(1), description: z.string().min(1) })).optional(),
    scope: z.enum(["project", "user"]).default("project"),
  })
  .strict();

export const ValidateExtensionArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
  })
  .strict();

export const EnableExtensionArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
  })
  .strict();

export const TrustExtensionArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
    note: z.string().optional(),
  })
  .strict();

export const UninstallExtensionArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
  })
  .strict();

export type CreateExtensionArgs = z.infer<typeof CreateExtensionArgsSchema>;
export type ValidateExtensionArgs = z.infer<typeof ValidateExtensionArgsSchema>;
export type EnableExtensionArgs = z.infer<typeof EnableExtensionArgsSchema>;
export type TrustExtensionArgs = z.infer<typeof TrustExtensionArgsSchema>;
export type UninstallExtensionArgs = z.infer<typeof UninstallExtensionArgsSchema>;

/**
 * The consolidated manager. Flat `action` enum with the union of the per-action
 * fields, validated per action in the handler — the same shape `scratchpad` and
 * `job` use. `id` is shared by every action that names an extension, and
 * `note` is trust-only.
 *
 * The create fields are spread through `partial()`: only `create` sets them, so
 * requiring them here would make `{action: "trust", id}` a schema violation.
 * Their defaults are applied by the strict re-parse inside `create`, not here.
 */
export const ExtensionManagerArgsSchema = z
  .object({
    action: z
      .enum(["create", "list", "validate", "enable", "trust", "uninstall"])
      .describe("author, inventory, validate, activate, trust, or remove an extension"),
    ...CreateExtensionArgsSchema.partial().shape,
    /** Free-text reason recorded with `action="trust"`. */
    note: z.string().optional(),
  })
  .strict();

export type ExtensionManagerArgs = z.infer<typeof ExtensionManagerArgsSchema>;
