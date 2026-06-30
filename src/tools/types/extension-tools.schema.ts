/**
 * Zod schemas for the 6 model-callable extension authoring tools.
 *
 *   create_extension      author a new extension (JS only)
 *   validate_extension    run validation.commands
 *   enable_extension      activate the extension
 *   trust_extension       promote to user-trusted (gated)
 *   uninstall_extension   remove (gated)
 *   reload_extensions     re-walk the disk
 */

import { z } from "zod";

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

const PERMISSIONS = [
  "tools:read_file",
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
          schema: z.record(z.unknown()).optional(),
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

export const ReloadExtensionsArgsSchema = z
  .object({
    from_dirs: z.array(z.enum(["user", "project", "builtin"])).optional(),
  })
  .strict();

export type CreateExtensionArgs = z.infer<typeof CreateExtensionArgsSchema>;
export type ValidateExtensionArgs = z.infer<typeof ValidateExtensionArgsSchema>;
export type EnableExtensionArgs = z.infer<typeof EnableExtensionArgsSchema>;
export type TrustExtensionArgs = z.infer<typeof TrustExtensionArgsSchema>;
export type UninstallExtensionArgs = z.infer<typeof UninstallExtensionArgsSchema>;
export type ReloadExtensionsArgs = z.infer<typeof ReloadExtensionsArgsSchema>;
