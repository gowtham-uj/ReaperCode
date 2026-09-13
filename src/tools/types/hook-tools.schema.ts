/**
 * Zod schemas for hook authoring, now a single model-callable tool.
 *
 *   hook_manager(action="create")     author a new hook as a draft
 *   hook_manager(action="list")       read-only inventory
 *   hook_manager(action="update")     re-compile and re-register
 *   hook_manager(action="approve")    compile + register, gated when enforce
 *   hook_manager(action="uninstall")  remove (gated)
 *
 * There is no `reload` action. `HookLifecycle.reload()` re-walks the hook
 * install dirs; the manager calls it after every mutation instead, so the live
 * runner is always consistent with disk without the model having to remember.
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

export type CreateHookArgs = z.infer<typeof CreateHookArgsSchema>;
export type ListHooksArgs = z.infer<typeof ListHooksArgsSchema>;
export type UpdateHookArgs = z.infer<typeof UpdateHookArgsSchema>;
export type ApproveHookArgs = z.infer<typeof ApproveHookArgsSchema>;
export type UninstallHookArgs = z.infer<typeof UninstallHookArgsSchema>;

/**
 * The consolidated manager. Flat `action` enum with the union of the per-action
 * fields, validated per action in the handler — the same shape `scratchpad` and
 * `job` use. `scope` is shared: `create` uses it as the install scope and
 * `list` uses it as a filter, and the two ranges agree on "project"/"user".
 *
 * The create fields are spread through `omit` + `partial()`: `scope` is
 * re-declared below with the wider range `list` needs, and the rest are
 * optional because only `create` sets them. Defaults are applied by the strict
 * re-parse inside `create`, not here.
 */
export const HookManagerArgsSchema = z
  .object({
    action: z
      .enum(["create", "list", "update", "approve", "uninstall"])
      .describe("author, inventory, re-register, approve, or remove a hook"),
    ...CreateHookArgsSchema.omit({ scope: true }).partial().shape,
    scope: z.enum(["project", "user", "all"]).optional(),
  })
  .strict();

export type HookManagerArgs = z.infer<typeof HookManagerArgsSchema>;
