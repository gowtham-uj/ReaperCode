/**
 * Zod schemas for the 6 model-callable hook authoring tools.
 *
 *   create_hook     author a new hook as a draft
 *   list_hooks      read-only inventory
 *   update_hook     re-compile and re-register
 *   approve_hook    compile + register (gated for enforce: true)
 *   uninstall_hook  remove (gated)
 *   reload_hooks    re-walk the disk
 */

import { z } from "zod";

const ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SOURCE_BYTES = 64 * 1024;

const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PreSkillInvoke",
  "PostSkillInvoke",
  "SkillCreated",
  "SkillSelected",
  "MemoryCandidate",
  "MemoryWritten",
  "MemoryRejected",
  "VisualArtifactAdded",
  "VisualAnalysisCompleted",
  "PreCompact",
  "PostCompact",
  "FileChanged",
] as const;

export const CreateHookArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX, "id must match kebab-case"),
    event: z.enum(HOOK_EVENTS),
    description: z.string().min(1).max(240),
    matcher: z
      .object({
        path_glob: z.string().optional(),
        tool_name: z.string().optional(),
        cmd_pattern: z.string().optional(),
      })
      .optional(),
    /** JS handler body. Compiled at approve_hook time. */
    source: z.string().min(1).max(MAX_SOURCE_BYTES),
    timeout_ms: z.number().int().positive().max(30000).optional(),
    /** false = observe-only (default), true = blockable. */
    enforce: z.boolean().default(false),
    scope: z.enum(["project", "user"]).default("project"),
  })
  .strict();

export const ListHooksArgsSchema = z
  .object({
    scope: z.enum(["project", "user", "all"]).default("all"),
  })
  .strict();

export const UpdateHookArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
    source: z.string().min(1).max(MAX_SOURCE_BYTES).optional(),
    matcher: z
      .object({
        path_glob: z.string().optional(),
        tool_name: z.string().optional(),
        cmd_pattern: z.string().optional(),
      })
      .optional(),
    timeout_ms: z.number().int().positive().max(30000).optional(),
    enforce: z.boolean().optional(),
  })
  .strict();

export const ApproveHookArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
  })
  .strict();

export const UninstallHookArgsSchema = z
  .object({
    id: z.string().regex(ID_REGEX),
  })
  .strict();

export const ReloadHooksArgsSchema = z
  .object({
    from_dirs: z.array(z.enum(["user", "project"])).optional(),
  })
  .strict();

export type CreateHookArgs = z.infer<typeof CreateHookArgsSchema>;
export type ListHooksArgs = z.infer<typeof ListHooksArgsSchema>;
export type UpdateHookArgs = z.infer<typeof UpdateHookArgsSchema>;
export type ApproveHookArgs = z.infer<typeof ApproveHookArgsSchema>;
export type UninstallHookArgs = z.infer<typeof UninstallHookArgsSchema>;
export type ReloadHooksArgs = z.infer<typeof ReloadHooksArgsSchema>;
