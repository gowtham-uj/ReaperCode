/**
 * ExtensionManifest + LoadedExtension + contribution kinds.
 *
 * An extension is a TS/JS plugin with a single `default.activate(ctx)`
 * entry. It may contribute tools, skills, slash commands, hooks,
 * panels, context providers, model providers, repo analyzers, test
 * runners, and diff renderers.
 *
 * Trust:
 *   - builtin        shipped under src/extensions/built-in
 *   - user-trusted   installed under ~/.reaper/extensions (trusted after install)
 *   - project-untrusted default for <workspace>/.reaper/extensions
 *
 * Status:
 *   - discovered  manifest found, not yet installed
 *   - installed  copied into the install dir, trust decided
 *   - enabled    activate() will run on next engine boot
 *   - disabled   activate() skipped
 *   - failed     activate() threw — error recorded
 */

export type ExtensionTrust = "builtin" | "user-trusted" | "project-untrusted";
export type ExtensionStatus = "discovered" | "installed" | "enabled" | "disabled" | "failed";

/** Hook events extensions may subscribe to. Mirrors + extends the
 *  existing Hooks (adaptive/types.ts) event union. The two new
 *  events are `SkillSelected` and `FileChanged`. */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PreSkillInvoke"
  | "PostSkillInvoke"
  | "SkillCreated"
  | "SkillSelected"
  | "MemoryCandidate"
  | "MemoryWritten"
  | "MemoryRejected"
  | "VisualArtifactAdded"
  | "VisualAnalysisCompleted"
  | "PreCompact"
  | "PostCompact"
  | "FileChanged";

/**
 * Tools contributed by an extension. The runtime merges these into
 * the static tool registry via `ExtensionToolRegistry`. Each tool
 * must ship with a `ToolMetadata` entry (governance policy gate).
 */
export interface ExtensionToolContribution {
  name: string;
  description: string;
  /** JSON-schema-like shape (the runtime does not enforce it; the
   *  metadata's `argsSchema` is what the policy gate looks at). */
  schema?: Record<string, unknown>;
}

export interface ExtensionSkillContribution {
  /** Path to skill.json relative to the extension root. */
  manifestPath: string;
}

export interface ExtensionSlashCommandContribution {
  name: string;
  description: string;
}

export interface ExtensionHookContribution {
  event: HookEventName;
  /** Default timeout for the handler (ms). Default 5000. */
  timeoutMs?: number;
}

export interface ExtensionPanelContribution {
  name: string;
  title: string;
}

export interface ExtensionContextProviderContribution {
  name: string;
  scope: "project" | "user";
}

export interface ExtensionModelProviderContribution {
  name: string;
}

export interface ExtensionRepoAnalyzerContribution {
  name: string;
}

export interface ExtensionTestRunnerContribution {
  name: string;
  command: string;
}

export interface ExtensionDiffRendererContribution {
  name: string;
}

export interface ExtensionContributions {
  tools?: ExtensionToolContribution[];
  skills?: ExtensionSkillContribution[];
  slashCommands?: ExtensionSlashCommandContribution[];
  hooks?: ExtensionHookContribution[];
  panels?: ExtensionPanelContribution[];
  contextProviders?: ExtensionContextProviderContribution[];
  modelProviders?: ExtensionModelProviderContribution[];
  repoAnalyzers?: ExtensionRepoAnalyzerContribution[];
  testRunners?: ExtensionTestRunnerContribution[];
  diffRenderers?: ExtensionDiffRendererContribution[];
}

/**
 * Permissions the extension asks for. The runtime grants only what
 * is declared; `ExtensionPermissionManager.check` rejects the rest.
 */
export type ExtensionPermission =
  | "tools:read_file"
  | "tools:write_file"
  | "tools:edit_file"
  | "tools:delete_file"
  | "tools:bash"
  | "tools:network"
  | "shell:low"
  | "shell:medium"
  | "shell:high"
  | "memory:project:read"
  | "memory:project:write"
  | "memory:user:read"
  | "memory:user:write"
  | "session:read"
  | "session:write";

export interface ExtensionManifest {
  /** kebab-case; regex ^[a-z][a-z0-9-]{0,63}$ */
  id: string;
  /** semver */
  version: string;
  description: string;
  /** Path to the entry, relative to the extension root, e.g. "dist/index.js" */
  main: string;
  /** Engine compatibility. */
  engines: { reaper: string };
  /** What the extension asks for. */
  permissions: ExtensionPermission[];
  /** What the extension contributes. */
  contributes?: ExtensionContributions;
  /** Minimum Reaper version (semver). */
  minimumReaperVersion?: string;
  author?: string;
  license?: string;
}

export interface LoadedExtension {
  id: string;
  manifest: ExtensionManifest;
  trust: ExtensionTrust;
  status: ExtensionStatus;
  installPath: string;
  loadedAt: number;
  error?: string;
}

/** Doctor output for `extensions doctor <id?>`. */
export interface ExtensionDoctorReport {
  id: string;
  manifestOk: boolean;
  mainLoads: boolean;
  toolsHaveMetadata: boolean;
  hookTimeoutsOk: boolean;
  contributionsValid: boolean;
  errors: string[];
}

/** Errors thrown by manifest/parser/loader. */
export class ExtensionValidationError extends Error {
  readonly field: string;
  readonly code: string;
  constructor(field: string, code: string, message: string) {
    super(`${field}: ${message} (${code})`);
    this.name = "ExtensionValidationError";
    this.field = field;
    this.code = code;
  }
}

/** Lower-case, kebab-case regex enforced by validator. */
export const EXTENSION_ID_REGEX = /^[a-z][a-z0-9-]{0,63}$/;

/** Semver range pattern: e.g. "^1.0.0", ">=1.0.0", "1.x", "1.0.0 - 2.0.0". */
export const SEMVER_RANGE_REGEX = /^(\^|~|\>=|\<=|\>|\<|=)?\d+\.\d+\.\d+([-+].*)?$/;
