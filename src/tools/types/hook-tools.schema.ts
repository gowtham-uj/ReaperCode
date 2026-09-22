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

/**
 * The matcher, with each field saying what it matches.
 *
 * The fields were bare `z.string().optional()` entries, so the only description
 * of a `path_glob` was its name. A hook author reads this schema and the tool
 * description and nothing else, and the difference between a glob that gates a
 * call and one that silently never fires is exactly the semantics this records.
 * `describe` reaches the model: `toJSONSchema` in `agent-tools.ts` renders the
 * string into the wire schema.
 */
export const HookMatcherSchema = z
  .object({
    path_glob: z
      .string()
      .optional()
      .describe(
        "Glob for the file the call touches, matched against the call's path argument. `*` matches within one path segment and `**` crosses segments and may match none, so `**/secrets/*.txt` matches both `secrets/token.txt` and `config/secrets/token.txt`. A pattern is compared against the path as written, as an absolute path, and relative to the workspace root, so `blocked.txt` gates a call that names the absolute path and the reverse.",
      ),
    tool_name: z
      .string()
      .optional()
      .describe("Tool this hook applies to, e.g. `bash` or `write_file`. A call to any other tool does not run the handler."),
    cmd_pattern: z
      .string()
      .optional()
      .describe("JavaScript regular expression tested against the command of a `bash` call, e.g. `rm\\s+-rf`. A call whose command does not match does not run the handler."),
  })
  .describe("Which calls this hook applies to. Fields are ANDed: every field set must match. An unset matcher applies to every call on the event.");

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
    matcher: HookMatcherSchema.optional(),
    /**
     * JS handler body. Compiled and registered by `create`.
     *
     * The contract is stated here because this is what the model reads before
     * writing a hook. `return { allow: false, reason }` blocks, a bare
     * `return false` blocks, and `{ allow: true, message }` advises; only
     * `enforce: true` makes a refusal mean anything.
     */
    source: z
      .string()
      .min(1)
      .max(MAX_SOURCE_BYTES)
      .describe(
        "Handler body, compiled with `new Function(event)`. The event carries `{ name, payload, blockable }`. Return `{ allow: false, reason }` to block, or a bare `false` to block with a message naming this hook, or `{ allow: true, message }` to allow and show advice on the tool result; `note` is accepted as a synonym for `message`. Only an `enforce: true` hook can block.",
      ),
    timeout_ms: z.number().int().positive().max(30000).optional(),
    /** false = observe-only (default), true = blockable. */
    enforce: z
      .boolean()
      .default(false)
      .describe(
        "Whether this hook may block a call. false (the default) is observe-only: a returned `allow: false` is dropped and only `message`/`note` reaches the model. true lets `{ allow: false, reason }` and a bare `return false` stop the call.",
      ),
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
    matcher: HookMatcherSchema.optional(),
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
