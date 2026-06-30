/**
 * Skill authoring tool handlers — the 5 model-callable tools that
 * exercise the SkillLifecycle (createDraft / approveDraft /
 * testSkill / uninstall / reload).
 *
 *   create_skill      → lifecycle.createDraft
 *   test_skill        → lifecycle.testSkill
 *   approve_skill     → approval gate + lifecycle.approveDraft
 *   uninstall_skill   → approval gate + lifecycle.uninstall
 *   reload_skills     → registry discover + memory sync
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
import type {
  CreateSkillArgs,
  TestSkillArgs,
  ApproveSkillArgs,
  UninstallSkillArgs,
  ReloadSkillsArgs,
} from "../types/skill-tools.schema.js";

/**
 * The runtime supplies this so the handlers can route the
 * approval decision through `request_human_approval`.
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
    trust: "draft",
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

export async function handleApproveSkill(
  args: ApproveSkillArgs,
  deps: SkillToolDeps,
): Promise<CreateSkillResult> {
  const record = deps.registry.get(args.name);
  if (!record) return { ok: false, error: `skill "${args.name}" not found` };
  if (record.trust !== "draft") {
    return { ok: false, name: args.name, trust: record.trust, error: `skill "${args.name}" is not a draft (trust=${record.trust})` };
  }
  if (deps.approvalRequester) {
    const allowed = await deps.approvalRequester({
      kind: "approve_skill",
      name: args.name,
      trust: "draft",
      scope: record.scope,
      skillDir: record.skillDir,
      description: record.manifest.description,
    });
    if (!allowed) return { ok: false, name: args.name, error: "denied by approval gate" };
  }
  const out = deps.lifecycle.approveDraft(args.name);
  if (!out.ok) return { ok: false, name: args.name, ...(out.error ? { error: out.error } : {}) };
  return { ok: true, name: out.name, skillDir: out.skillDir, trust: out.trust };
}

export async function handleUninstallSkill(
  args: UninstallSkillArgs,
  deps: SkillToolDeps,
): Promise<{ ok: boolean; error?: string }> {
  const record = deps.registry.get(args.name);
  if (record && record.trust !== "draft" && deps.approvalRequester) {
    const allowed = await deps.approvalRequester({
      kind: "uninstall_skill",
      name: args.name,
      trust: record.trust,
      scope: args.scope,
      skillDir: record.skillDir,
      description: record.manifest.description,
    });
    if (!allowed) return { ok: false, error: "denied by approval gate" };
  }
  return deps.lifecycle.uninstall(args.name, args.scope);
}

export function handleReloadSkills(
  _args: ReloadSkillsArgs,
  deps: SkillToolDeps,
): { ok: boolean; loaded: number } {
  // The registry already tracks every record in memory; the router
  // is stateless and reads the current records on each selectTopN
  // call, so there's nothing to invalidate. A no-op for symmetry
  // with the extension/hook reload handlers.
  const all = deps.registry.list({ includeUntrusted: true });
  return { ok: true, loaded: all.length };
}