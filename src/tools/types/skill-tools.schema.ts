/**
 * Zod schemas for skill authoring, now a single model-callable tool.
 *
 *   skill_manager(action="create")     author a new skill as a draft
 *   skill_manager(action="test")       run validation.commands for a skill
 *   skill_manager(action="approve")    promote a draft to user-trusted (gated)
 *   skill_manager(action="uninstall")  remove a skill (gated for non-draft)
 *
 * There is no `reload` action. Skill state is fully in memory — `list` and
 * `selectTopN` read the current records on every call, and the lifecycle
 * registers into the registry on every mutation — so the only honest
 * implementation of a reload tool was to return the count it already had.
 * A tool that cannot do anything is worse than no tool: it teaches the model
 * that hand-copied skill folders need a nudge to appear, which was never true.
 */

import { z } from "zod";

const NAME_REGEX = /^[a-z][a-z0-9-]{0,63}$/;
const CATEGORIES = [
  "repo-understanding",
  "bug-fixing",
  "test-failure-debugging",
  "typescript-refactor",
  "python-debugging",
  "frontend-react-debugging",
  "api-backend-debugging",
  "security-review",
  "performance-review",
  "documentation-writing",
  "terminal-bench-solving",
  "swe-bench-solving",
  "agent-runtime-debugging",
  "session-persistence",
  "prompt-enhancement",
] as const;

export const CreateSkillArgsSchema = z.object({
  name: z.string().regex(NAME_REGEX, "name must match kebab-case ^[a-z][a-z0-9-]{0,63}$"),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version must be semver").default("0.1.0"),
  description: z.string().min(1).max(240),
  category: z.enum(CATEGORIES),
  when_to_use: z.string().min(1),
  body: z.string().min(1).max(64 * 1024),
  allowed_tools: z.array(z.string()).default([]),
  triggers: z.array(z.string()).optional(),
  path_patterns: z.array(z.string()).optional(),
  validation_commands: z
    .array(z.object({ id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional() }))
    .optional(),
  memory_policy: z
    .object({
      may_read_project_memory: z.boolean().default(true),
      may_write_project_memory: z.boolean().default(true),
      may_read_user_memory: z.boolean().default(false),
      may_write_user_memory: z.boolean().default(false),
    })
    .optional(),
  scope: z.enum(["project", "user"]).default("project"),
}).strict();

export const TestSkillArgsSchema = z
  .object({
    name: z.string().regex(NAME_REGEX),
  })
  .strict();

export const ApproveSkillArgsSchema = z
  .object({
    name: z.string().regex(NAME_REGEX),
  })
  .strict();

export const UninstallSkillArgsSchema = z
  .object({
    name: z.string().regex(NAME_REGEX),
    scope: z.enum(["user", "project", "builtin"]).default("user"),
  })
  .strict();

/**
 * The consolidated manager.
 *
 * A flat `action` enum with optional fields, validated per action in the
 * handler — the same shape `scratchpad` and `job` already use. The alternative
 * (a discriminated union) buys schema-level enforcement at the cost of a much
 * larger wire schema on every turn for a tool the model reaches for rarely,
 * and the handler's error message is more useful than a schema violation
 * anyway: it can name the action that was asked for and the field it needs.
 *
 * `scope` is the union of the create and uninstall ranges. `create` re-parses
 * through `CreateSkillArgsSchema`, which rejects `builtin` with the same
 * message it always did.
 *
 * The create fields are spread through `partial()`: only `create` sets them, so
 * requiring them here would make `{action: "test", name}` — the common case —
 * a schema violation, and the model would have to send an entire skill
 * definition it is not authoring. Defaults are deliberately *not* applied at
 * this level either; `create` re-parses through the strict create schema, which
 * is where `version` and `scope` get their defaults.
 */
export const SkillManagerArgsSchema = z
  .object({
    action: z
      .enum(["create", "test", "approve", "uninstall"])
      .describe("create a draft skill, test one, approve a draft, or uninstall one"),
    ...CreateSkillArgsSchema.omit({ scope: true }).partial().shape,
    scope: z.enum(["project", "user", "builtin"]).optional(),
  })
  .strict();

export type SkillManagerArgs = z.infer<typeof SkillManagerArgsSchema>;

export type CreateSkillArgs = z.infer<typeof CreateSkillArgsSchema>;
export type TestSkillArgs = z.infer<typeof TestSkillArgsSchema>;
export type ApproveSkillArgs = z.infer<typeof ApproveSkillArgsSchema>;
export type UninstallSkillArgs = z.infer<typeof UninstallSkillArgsSchema>;
