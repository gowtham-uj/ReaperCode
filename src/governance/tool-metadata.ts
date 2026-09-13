/**
 * Tool metadata: the per-tool classification layer that powers the
 * ToolPolicy system.
 *
 * The existing `src/tools/registry.ts` describes every tool's API
 * (description + argument schema). The metadata in this file adds the
 * *governance* view: how dangerous is this tool, what category of
 * work does it belong to, who is allowed to call it, and what tools
 * should it be sequenced with.
 *
 * Three things this module is NOT:
 *   - It is not a re-implementation of `src/policy/classifier.ts`.
 *     The classifier produces a binary `safe | dangerous |
 *     needs_confirmation` outcome for a tool call. The metadata here
 *     is the *static, structural* classification; the classifier is
 *     the *dynamic, instance-level* one.
 *   - It is not a replacement for `src/tools/tool-allowlist.ts`. The
 *     allowlist gates unknown tool names and unknown argument keys;
 *     this module gates *known* tools by role, risk, and ordering.
 *   - It is not hard-coded to a specific ecosystem. Tool names
 *     come from `src/tools/registry.ts`; categories and risk
 *     levels are based on observable tool behavior, not on
 *     language or project.
 *
 * Categories are intentionally coarse. The risk ladder is:
 *   - "low"      read-only, no host side effects
 *   - "medium"   local mutation, can be undone from the trajectory
 *   - "high"     external side effect (network, process, browser)
 *   - "critical" irreversible or auth-bearing action
 */

import { KNOWN_TOOLS } from "../tools/tool-allowlist.js";

/* -------------------------------------------------------------------------- */
/*                                Type surface                               */
/* -------------------------------------------------------------------------- */

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ToolCategory =
  | "read"
  | "search"
  | "write"
  | "shell"
  | "service"
  | "browser"
  | "computer"
  | "process"
  | "human"
  | "skill"
  | "plan"
  | "task"
  | "control"
  | "discovery";

export type PolicyRole =
  | "explorer"
  | "architect"
  | "implementer"
  | "test"
  | "reviewer"
  | "critic"
  | "browser"
  | "root";

export interface ToolMetadata {
  /** Tool name as registered in src/tools/registry.ts. */
  name: string;
  /** Coarse category for grouping and ordering. */
  category: ToolCategory;
  /** Static risk level. */
  risk_level: RiskLevel;
  /** True iff the tool never modifies persistent state. */
  is_read_only: boolean;
  /** True iff the tool can change files inside the workspace. */
  can_modify_files: boolean;
  /** True iff the tool can run arbitrary code or commands. */
  can_execute_code: boolean;
  /** True iff the tool can drive a graphical user interface. */
  can_control_ui: boolean;
  /** True iff the tool can affect the host OS, not just the workspace. */
  can_affect_host: boolean;
  /**
   * True iff the tool *must* require explicit human or supervisor
   * approval before execution, even when the caller is otherwise
   * permitted. This is the per-tool override that lives above
   * role-based permissions — for tools that should never auto-run.
   */
  requires_approval: boolean;
  /**
   * Tools the model should prefer to call *before* this one. The
   * policy engine emits an advisory note (not a hard block) when
   * the inverse sequence is detected, e.g. "you wrote a file
   * without reading it first".
   */
  preferred_before: string[];
  /**
   * Tools the model should prefer to call *after* this one. The
   * symmetric inverse of preferred_before.
   */
  preferred_after: string[];
  /**
   * Roles for which this tool is structurally forbidden. An entry
   * here ALWAYS denies, even if the role's allowlist would permit.
   */
  forbidden_in_roles: readonly PolicyRole[];
  /**
   * Roles for which this tool is explicitly required / preferred
   * (used by the preferred-ordering engine to suggest role-aware
   * tool sets). An empty list means "no role-specific preference".
   */
  allowed_in_roles: readonly PolicyRole[];
}

/* -------------------------------------------------------------------------- */
/*                              Governance roles                              */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                              The metadata map                              */
/* -------------------------------------------------------------------------- */

export const TOOL_METADATA: Record<string, ToolMetadata> = {
  // ---- Read ----
  file_view: {
    name: "file_view",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "delete_file", "bash"],
    preferred_after: ["file_find", "grep_search"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  list_directory: {
    name: "list_directory",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  skim_file: {
    name: "skim_file",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "root"],
  },
  inspect_environment: {
    name: "inspect_environment",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["bash", "write_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  // ---- Search / discovery ----
  grep_search: {
    name: "grep_search",
    category: "search",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "write_file", "edit_file", "file_edit"],
    preferred_after: ["list_directory"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  file_find: {
    name: "file_find",
    category: "search",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "file_edit", "write_file"],
    preferred_after: ["list_directory"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  web_search: {
    name: "web_search",
    category: "search",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // egress
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["web_fetch"],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  web_fetch: {
    name: "web_fetch",
    category: "search",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // egress
    requires_approval: false,
    preferred_before: ["web_search"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  search_tools: {
    name: "search_tools",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  diagnostics: {
    name: "diagnostics",
    // Runs external linters/tsc as a child process; output is
    // advisory-only and never blocks writes.
    category: "service",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: true, // executes tsc / eslint via execFile
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "edit_file", "file_edit"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  /*
   * `glob`, `git_status`, and `git_diff` are core — rendered with full schemas
   * on every turn — so they must be evaluable. A tool the model can always see
   * but the policy layer refuses with "add it to tool-metadata.ts" is a tool
   * that fails only for subagent roles, which is the hardest place to see it.
   */
  glob: {
    name: "glob",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "grep_search"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  git_status: {
    name: "git_status",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "delete_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  git_diff: {
    name: "git_diff",
    category: "read",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["write_file", "file_edit", "delete_file"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },

  // ---- Write ----
  write_file: {
    name: "write_file",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "inspect_environment", "grep_search"],
    preferred_after: ["bash"], // for typecheck / build
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  edit_file: {
    name: "edit_file",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "grep_search"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  file_edit: {
    name: "file_edit",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view", "file_find", "grep_search"],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  delete_file: {
    name: "delete_file",
    category: "write",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["file_view"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Shell ----
  bash: {
    name: "bash",
    category: "shell",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: true,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false, // approval is driven by classifyCommandRisk
    preferred_before: ["file_view", "inspect_environment", "grep_search"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  /*
   * Code Mode. Classified alongside `bash` because it is the same surface with
   * a larger reach: a script can run `bash`'s equivalent through `child_process`,
   * plus npm packages, network calls, and real parallelism, and can do it from
   * a loop the model wrote.
   *
   * The role lists are deliberately identical to `bash`, and the reason is the
   * one thing about eval a metadata table cannot express: `can_execute_code` and
   * `can_affect_host` describe the *tool*, and eval's script is opaque to the
   * policy engine. There is no `args.cmd` to classify, so there is no equivalent
   * of `classifyCommandRisk` and no `shell_approval_required` path — a script
   * that writes files and exfiltrates them looks exactly like one that sums an
   * array. Handing eval to a read-only role would therefore not be a narrower
   * grant than handing it to a writer, the way `file_view` is narrower than
   * `write_file`; it would be the widest grant in the system, handed out under
   * the name of a read tool. Roles that cannot be trusted with `bash` cannot be
   * trusted with eval, so they are listed as forbidden.
   *
   * `requires_approval` is false for the same reason `bash`'s is: gating it here
   * would put a human approval in front of every eval, including the read-many-
   * files loop that is the feature's whole point. That is a real gap rather than
   * a considered tradeoff — bash pays for `requires_approval: false` with a
   * per-command classifier, and eval has no such check to pay with. It is called
   * out here so it is not mistaken for a decision someone made deliberately.
   */
  eval: {
    name: "eval",
    category: "shell",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true,
    can_execute_code: true,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Browser ----
  browser_control: {
    name: "browser_control",
    category: "browser",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true,
    can_control_ui: true,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: ["web_search", "web_fetch"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "root"],
    allowed_in_roles: ["browser"],
  },

  // ---- Process ----
  /*
   * `job` is the process verb for *reading* a background process you already
   * started. Its risk is `medium`, not `high`, because its three actions are
   * not one risk: `list` and `poll` observe, `cancel` and `write` mutate the
   * running process. The executor narrows on the action at dispatch time; the
   * metadata has to describe the whole tool, so it takes the higher of the
   * two. `bash` remains the only way to *start* a process, and it is where
   * the spawn decision is gated.
   */
  job: {
    name: "job",
    category: "process",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true,
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["bash"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Skills / artifacts ----
  activate_skill: {
    name: "activate_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
// ---- Plan / task control ----
  advance_step: {
    name: "advance_step",
    category: "plan",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["bash", "write_file", "edit_file", "file_edit"],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root"],
  },


  update_plan: {
    name: "update_plan",
    category: "plan",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "explorer", "architect", "implementer", "test", "reviewer", "critic"],
  },
  update_todo: {
    name: "update_todo",
    category: "task",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["root", "explorer", "architect", "implementer", "test", "reviewer", "critic"],
  },

  // ---- Authoring: Skills (5) ----
  create_skill: {
    name: "create_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true, // writes <scope>/.reaper/skills/<name>/
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands as draft; activate_skill is the gated step
    preferred_before: ["activate_skill"],
    preferred_after: ["test_skill", "approve_skill"],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "test", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  test_skill: {
    name: "test_skill",
    category: "skill",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // runs manifest.validation.commands
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["approve_skill"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  approve_skill: {
    name: "approve_skill",
    category: "skill",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // promotes draft → user-trusted
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated by the approval flow
    preferred_before: ["create_skill", "test_skill"],
    preferred_after: ["activate_skill"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_skill: {
    name: "uninstall_skill",
    category: "skill",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes skill folder + memory index
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_skills: {
    name: "reload_skills",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: ["activate_skill"],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Authoring: Extensions (6, JS only) ----
  create_extension: {
    name: "create_extension",
    category: "write",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // writes extension.json + main.js to disk
    can_execute_code: false, // compile happens later, on trust_
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands dormant + project-untrusted
    preferred_before: ["validate_extension", "trust_extension"],
    preferred_after: ["enable_extension"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  validate_extension: {
    name: "validate_extension",
    category: "write",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // runs validation.commands
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: ["trust_extension"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "test", "root"],
  },
  enable_extension: {
    name: "enable_extension",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // calls default.activate(ctx) — runs extension code
    can_control_ui: false,
    can_affect_host: true, // extension may register tools that touch the host
    requires_approval: true, // gated — extension must be user-trusted first
    preferred_before: ["trust_extension"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  trust_extension: {
    name: "trust_extension",
    category: "control",
    risk_level: "critical",
    is_read_only: false,
    can_modify_files: false, // trust lives in the in-memory registry
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: true, // trust change can authorize future code execution
    requires_approval: true, // gated by the approval flow — user must see the source
    preferred_before: ["create_extension", "validate_extension"],
    preferred_after: ["enable_extension"],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_extension: {
    name: "uninstall_extension",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes extension folder + registry entries
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_extensions: {
    name: "reload_extensions",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },

  // ---- Authoring: Hooks (6, JS handlers, observe-only by default) ----
  create_hook: {
    name: "create_hook",
    category: "control",
    risk_level: "medium",
    is_read_only: false,
    can_modify_files: true, // writes <scope>/.reaper/hooks/<id>.json
    can_execute_code: false, // compile happens on approve
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false, // lands as draft
    preferred_before: ["approve_hook"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser"],
    allowed_in_roles: ["implementer", "root"],
  },
  list_hooks: {
    name: "list_hooks",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
  },
  update_hook: {
    name: "update_hook",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // re-writes the hook JSON
    can_execute_code: false, // compile happens during the call
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // re-gated if enforce flips false → true
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  approve_hook: {
    name: "approve_hook",
    category: "control",
    risk_level: "critical",
    is_read_only: false,
    can_modify_files: false,
    can_execute_code: true, // compiles and registers a live handler
    can_control_ui: false,
    can_affect_host: true, // an enforce:true hook can block tool calls system-wide
    requires_approval: true, // gated by the approval flow — user must see the JS source
    preferred_before: ["create_hook"],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  uninstall_hook: {
    name: "uninstall_hook",
    category: "control",
    risk_level: "high",
    is_read_only: false,
    can_modify_files: true, // removes hook JSON + unregisters from runner
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: true, // gated
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: ["explorer", "architect", "test", "reviewer", "critic", "browser", "implementer"],
    allowed_in_roles: ["root"],
  },
  reload_hooks: {
    name: "reload_hooks",
    category: "discovery",
    risk_level: "low",
    is_read_only: true,
    can_modify_files: false,
    can_execute_code: false,
    can_control_ui: false,
    can_affect_host: false,
    requires_approval: false,
    preferred_before: [],
    preferred_after: [],
    forbidden_in_roles: [],
    allowed_in_roles: ["implementer", "test", "root"],
  },
};

/* -------------------------------------------------------------------------- */
/*                                 Helpers                                    */
/* -------------------------------------------------------------------------- */

export function getToolMetadata(name: string): ToolMetadata | null {
  return TOOL_METADATA[name] ?? null;
}

export function hasToolMetadata(name: string): boolean {
  return name in TOOL_METADATA;
}

/**
 * True iff every tool in `src/tools/tool-allowlist.ts` is also
 * classified here. This is the "no orphan tool" invariant that
 * prevents the policy engine from silently allowing a new tool
 * added to the registry without metadata. Drift here is a bug.
 */
export function assertMetadataCoversRegistry(): {
  ok: boolean;
  missing: string[];
  extras: string[];
} {
  const missing: string[] = [];
  for (const name of KNOWN_TOOLS) {
    if (!hasToolMetadata(name)) missing.push(name);
  }
  // Extras: tools that have metadata but were removed from the
  // registry. We allow these silently (they cost nothing and may
  // be referenced by tests), but we surface them so callers can
  // clean up.
  const extras: string[] = [];
  for (const name of Object.keys(TOOL_METADATA)) {
    if (!KNOWN_TOOLS.has(name)) extras.push(name);
  }
  return { ok: missing.length === 0, missing, extras };
}

