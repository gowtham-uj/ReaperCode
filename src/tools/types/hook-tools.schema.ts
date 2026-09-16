/**
 * Zod schemas for hook authoring, now a single model-callable tool.
 *
 *   hook_manager(action="create")     author a hook; live on the next event
 *   hook_manager(action="list")       read-only inventory
 *   hook_manager(action="update")     re-compile and re-register
 *   hook_manager(action="approve")    no-op; kept so an old caller still works
 *   hook_manager(action="uninstall")  remove from disk and the live runner
 *
 * No approval gate, and no trust tiers. `create` writes the file, compiles it,
 * and attaches it to the runner in one call — there is no intermediate state a
 * later `approve` would promote out of.
 *
 * There is no `reload` action. `HookLifecycle.reload()` re-walks the hook
 * install dirs, and the manager re-walks via `discover()` before every action,
 * so the live runner is always consistent with disk without the model having to
 * remember.
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
    /** JS handler body. Compiled and registered by `create`. */
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
    /*
     * `description` and `event` are here because `update` accepts them.
     *
     * Both were reachable through the manager's flat enum, and neither had a
     * field on this schema, so a typed `update` could not carry them and the
     * lifecycle had no way to receive them. The result was an update that
     * reported success and changed only `updatedAt`. A field the tool advertises
     * has to exist on the shape the handler is typed against, or "accepted" is a
     * claim the code does not honour.
     */
    description: z.string().min(1).max(240).optional(),
    event: z.enum(HOOK_EVENTS).optional(),
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
 * The consolidated manager, as an action-discriminated union.
 *
 * This used to be one object whose only required field was `action`; every
 * create field was `.partial()` and the handler re-parsed it later. Runtime
 * validation worked, but `tools.describe("hook_manager")` truthfully reported
 * `required: ["action"]`, so a model had no machine-readable way to learn that
 * create also requires `id`, `event`, `description` and `source`. Prose in the
 * tool description was not enough: the schema is what code mode inspects.
 *
 * Each action now carries its own real schema. The runtime and the descriptor
 * therefore agree by construction: a create call is incomplete before it ever
 * reaches the handler, and describe exposes the conditional required fields in
 * the generated union rather than pretending they are optional.
 */
export const HookManagerArgsSchema = z.discriminatedUnion("action", [
  CreateHookArgsSchema.extend({ action: z.literal("create") }),
  ListHooksArgsSchema.extend({ action: z.literal("list") }),
  UpdateHookArgsSchema.extend({ action: z.literal("update") }),
  ApproveHookArgsSchema.extend({ action: z.literal("approve") }),
  UninstallHookArgsSchema.extend({ action: z.literal("uninstall") }),
]);

/*
 * Input rather than output: callers constructing a list request may omit its
 * defaulted scope, and Zod fills it during parse. The handler receives parsed
 * output in production, but its public type is also used by focused unit tests
 * and direct callers, and requiring a field whose schema gives it a default is
 * a lie at those call sites.
 */
export type HookManagerArgs = z.input<typeof HookManagerArgsSchema>;
