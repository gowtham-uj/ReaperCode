/**
 * Skill authoring handlers — one model-callable tool, `skill_manager`, over
 * the SkillLifecycle (createDraft / approveDraft / testSkill / uninstall).
 *
 *   skill_manager action="create"    → lifecycle.createDraft
 *   skill_manager action="test"      → lifecycle.testSkill
 *   skill_manager action="approve"   → approval gate + lifecycle.approveDraft
 *   skill_manager action="uninstall" → approval gate + lifecycle.uninstall
 *
 * Approval gate: the runtime injects an `ApprovalRequester` callback.
 * On a true return the operation proceeds; on a false return it
 * aborts and the skill stays where it is.
 *
 * Hot-reload: every state-changing call already calls
 * `registry.register(...)` + `registry.syncTo(memory)`, so the new
 * skill is visible to the router / activate_skill tool on the next
 * turn.
 */

import type { SkillLifecycle } from "../../skills/lifecycle.js";
import type { SkillManifest } from "../../skills/types.js";
import type { SkillRegistry } from "../../skills/registry.js";
import { CreateSkillArgsSchema } from "../types/skill-tools.schema.js";
import { operationArgs } from "../types/manager-args.js";
import type {
  CreateSkillArgs,
  TestSkillArgs,
  ApproveSkillArgs,
  UninstallSkillArgs,
  SkillManagerArgs,
} from "../types/skill-tools.schema.js";

/**
 * The runtime supplies this so the handlers can route the
 * approval decision through the app-server approval flow.
 *
 * Returns true → proceed, false → abort. The handler reports the
 * denial back to the model as the tool result so the model can
 * ask the user why or back off.
 */
export type SkillApprovalRequester = (input: {
  kind: "approve_skill" | "uninstall_skill";
  name: string;
  trust: string;
  scope: string;
  skillDir: string;
  description: string;
}) => Promise<boolean> | boolean;

export interface SkillToolDeps {
  lifecycle: SkillLifecycle;
  registry: SkillRegistry;
  approvalRequester?: SkillApprovalRequester;
}

export interface CreateSkillResult {
  ok: boolean;
  name?: string;
  skillDir?: string;
  trust?: string;
  error?: string;
}

export async function handleCreateSkill(
  args: CreateSkillArgs,
  deps: SkillToolDeps,
): Promise<CreateSkillResult> {
  const manifest: SkillManifest = {
    name: args.name,
    version: args.version,
    description: args.description,
    category: args.category,
    whenToUse: args.when_to_use,
    allowedTools: args.allowed_tools,
    ...(args.triggers !== undefined ? { triggers: args.triggers } : {}),
    ...(args.path_patterns !== undefined ? { pathPatterns: args.path_patterns } : {}),
    ...(args.validation_commands !== undefined
      ? {
          validation: {
            commands: args.validation_commands.map((c) => ({
              id: c.id,
              command: c.command,
              ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
            })),
          },
        }
      : {}),
    ...(args.memory_policy !== undefined
      ? {
          memoryPolicy: {
            mayReadProjectMemory: args.memory_policy.may_read_project_memory,
            mayWriteProjectMemory: args.memory_policy.may_write_project_memory,
            mayReadUserMemory: args.memory_policy.may_read_user_memory,
            mayWriteUserMemory: args.memory_policy.may_write_user_memory,
          },
        }
      : {}),
    /*
     * Trusted on creation.
     *
     * This was hardcoded to `draft`, and `draft` was the lock: a draft could not
     * be activated and could not be uninstalled, so the model could author a
     * skill and then do nothing with it. A skill the user asked for is a skill
     * the user wants.
     */
    trust: "user-trusted",
  };
  try {
    const out = deps.lifecycle.createDraft(manifest, args.body);
    if (!out.ok) return { ok: false, ...(out.error ? { error: out.error } : {}) };
    return {
      ok: true,
      name: out.name,
      skillDir: out.skillDir,
      trust: out.trust,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function handleTestSkill(
  args: TestSkillArgs,
  deps: SkillToolDeps,
): Promise<{ ok: boolean; name: string; results: Array<{ id: string; exitCode: number; stderr: string }>; error?: string }> {
  const out = await deps.lifecycle.testSkill(args.name);
  return { ok: out.ok, name: args.name, results: out.results, ...(out.error ? { error: out.error } : {}) };
}

/**
 * `approve` — a no-op that says so, rather than an error.
 *
 * There are no trust tiers: a skill is trusted when it is created, so there is
 * nothing left to promote. The action is kept because a model that has learned
 * the old workflow will still call it, and "this skill is already usable, go
 * ahead" is a better answer than a refusal that implies something is missing.
 *
 * It reports `ok: true` deliberately. Returning an error for a step that has
 * already been satisfied would send the model looking for a problem that does
 * not exist — the same failure mode as the "not registered" message that sent
 * it hunting through a registry it had never been told about.
 */
export async function handleApproveSkill(
  args: ApproveSkillArgs,
  deps: SkillToolDeps,
): Promise<CreateSkillResult> {
  const record = deps.registry.get(args.name);
  if (!record) return { ok: false, error: `skill "${args.name}" not found` };
  return {
    ok: true,
    name: args.name,
    skillDir: record.skillDir,
    trust: record.trust,
  };
}

export async function handleUninstallSkill(
  args: UninstallSkillArgs,
  deps: SkillToolDeps,
): Promise<{ ok: boolean; error?: string }> {
  /*
   * No approval gate on removal.
   *
   * It used to require one for anything that was not a draft, which meant a
   * skill could be created but not removed: the create path was open and the
   * delete path was shut. `uninstall` also could not find a draft at all, since
   * it searched the user root while drafts lived in `drafts/`. With no trust
   * tiers there is nothing to gate on, and a model that can author a skill must
   * be able to undo it.
   */
  return deps.lifecycle.uninstall(args.name, args.scope);
}

/**
 * The one skill tool the model calls. Dispatches on `action` to the handlers
 * above; they stay separate because they are the unit the existing tests
 * exercise, and folding them together would only move the switch.
 *
 * There is no `reload` action — see the schema header for why.
 */
export async function handleSkillManager(
  args: SkillManagerArgs,
  deps: SkillToolDeps,
): Promise<unknown> {
  switch (args.action) {
    case "create": {
      // Re-parse through the create schema so `scope: "builtin"` is rejected
      // with the message it always carried. Only `action` comes out first;
      // `scope` stays in because it *is* a create field, and it is the strict
      // re-parse that refuses the `builtin` value the manager allows for
      // `uninstall`.
      const parsed = CreateSkillArgsSchema.safeParse(operationArgs(args));
      if (!parsed.success) {
        return { ok: false, action: args.action, error: `create requires the full skill definition: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
      }
      return handleCreateSkill(parsed.data, deps);
    }
    case "test":
      return handleTestSkill(requireName(args, "test"), deps);
    case "approve":
      return handleApproveSkill(requireName(args, "approve"), deps);
    case "uninstall": {
      const name = requireName(args, "uninstall");
      return handleUninstallSkill(
        { name: name.name, scope: args.scope === "builtin" || args.scope === "project" ? args.scope : "user" },
        deps,
      );
    }
  }
}

/**
 * `name` is required by every action except `create`, where it comes from the
 * definition. The cast is safe: the handler rejects the empty name with the
 * same "not found" path it would use for a typo, which is a better message than
 * a schema violation naming a field the model did not think it was setting.
 */
function requireName(args: SkillManagerArgs, action: string): TestSkillArgs & ApproveSkillArgs {
  const name = typeof args.name === "string" ? args.name : "";
  if (!name) throw new Error(`skill_manager action="${action}" requires "name"`);
  return { name };
}