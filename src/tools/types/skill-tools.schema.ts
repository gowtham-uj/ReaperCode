/**
 * Zod schemas for the 5 model-callable skill authoring tools.
 *
 *   create_skill      author a new skill as a draft
 *   test_skill        run validation.commands for a skill
 *   approve_skill     promote a draft to user-trusted (gated)
 *   uninstall_skill   remove a skill (gated for non-draft)
 *   reload_skills     re-walk the disk and rebuild the registry
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

export const ReloadSkillsArgsSchema = z
  .object({
    from_dirs: z.array(z.enum(["user", "project", "builtin"])).optional(),
  })
  .strict();

export type CreateSkillArgs = z.infer<typeof CreateSkillArgsSchema>;
export type TestSkillArgs = z.infer<typeof TestSkillArgsSchema>;
export type ApproveSkillArgs = z.infer<typeof ApproveSkillArgsSchema>;
export type UninstallSkillArgs = z.infer<typeof UninstallSkillArgsSchema>;
export type ReloadSkillsArgs = z.infer<typeof ReloadSkillsArgsSchema>;
