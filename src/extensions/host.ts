/**
 * ReaperExtensionContext — the full activation context an extension
 * receives in `default.activate(ctx)`. This is the public API the
 * extension author sees; everything else in src/extensions/ is
 * implementation detail.
 *
 * Every register method takes a typed contribution object (see
 * `contribution-types.ts`) and records it on the right surface.
 * Failures are surfaced as thrown errors so the extension author
 * sees them in their activate() body — the registry wraps activate()
 * in a try/catch so a thrown error becomes `{status: "failed"}` and
 * the host keeps running.
 *
 * `log.info / warn / error` write to the host's logger (no raw
 * secrets). `workspace` exposes the install paths. `permissions`
 * exposes the grant API; extensions may request additional
 * permissions at runtime, which the host surfaces as a UI prompt
 * (or a no-op in CLI mode).
 */

import type { SkillManifest } from "../skills/types.js";
import type { ToolMetadata } from "../governance/tool-metadata.js";
import type {
  ExtensionSlashCommandRegistration,
  ExtensionSkillRegistration,
  ExtensionPanelRegistration,
  ExtensionToolRegistration,
  ExtensionHookRegistration,
  ContextProviderContribution,
  ModelProviderContribution,
  RepoAnalyzerContribution,
  TestRunnerContribution,
  DiffRendererContribution,
} from "./contribution-types.js";
import type { ExtensionPermission } from "./types.js";
import { redactSecrets } from "../adaptive/redact.js";

export interface ReaperExtensionContext {
  readonly extensionId: string;
  readonly trust: "builtin" | "user-trusted" | "project-untrusted";

  /** Register a tool. The `metadata` is REQUIRED — the policy gate
   *  will deny the tool at runtime without it. */
  registerTool(registration: ExtensionToolRegistration): void;

  /** Register a skill (the host merges it into the SkillRegistry). */
  registerSkill(registration: ExtensionSkillRegistration): void;

  /** Register a slash command (e.g. "/hello"). The host surfaces it
   *  via the SlashCommandRegistry. */
  registerSlashCommand(registration: ExtensionSlashCommandRegistration): void;

  /** Register a hook handler with a per-event timeout. */
  registerHook(registration: ExtensionHookRegistration): void;

  /** Register a panel (TUI-side; the CLI ignores this). */
  registerPanel(registration: ExtensionPanelRegistration): void;

  /** Register a context provider. */
  registerContextProvider(provider: ContextProviderContribution): void;

  /** Register a model provider. */
  registerModelProvider(provider: ModelProviderContribution): void;

  /** Register a repo analyzer. */
  registerRepoAnalyzer(analyzer: RepoAnalyzerContribution): void;

  /** Register a test runner. */
  registerTestRunner(runner: TestRunnerContribution): void;

  /** Register a diff renderer. */
  registerDiffRenderer(renderer: DiffRendererContribution): void;

  /** Log helpers (secrets are redacted before emission). */
  log: ExtensionLogger;

  /** Workspace + install paths. */
  workspace: {
    root: string;
    scratchpad: string;
    extensionInstallPath: string;
  };

  /** Permission grant API. */
  permissions: {
    request(p: ExtensionPermission): Promise<boolean>;
    has(p: ExtensionPermission): boolean;
  };
}

export interface ExtensionLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}

export interface ExtensionLoggerSink {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ExtensionHostOptions {
  extensionId: string;
  trust: ReaperExtensionContext["trust"];
  workspaceRoot: string;
  scratchpadPath: string;
  extensionInstallPath: string;
  /** Where log lines go. Defaults to a no-op sink. */
  logSink?: ExtensionLoggerSink | undefined;
  /** Tool registration sink — the registry wires this in. */
  onRegisterTool?: ((registration: ExtensionToolRegistration) => void) | undefined;
  /** Skill registration sink. */
  onRegisterSkill?: ((registration: ExtensionSkillRegistration) => void) | undefined;
  /** Slash command registration sink. */
  onRegisterSlashCommand?: ((registration: ExtensionSlashCommandRegistration) => void) | undefined;
  /** Hook registration sink. */
  onRegisterHook?: ((registration: ExtensionHookRegistration) => void) | undefined;
  /** Panel registration sink (ignored by CLI). */
  onRegisterPanel?: ((registration: ExtensionPanelRegistration) => void) | undefined;
  /** Context provider sink. */
  onRegisterContextProvider?: ((provider: ContextProviderContribution) => void) | undefined;
  /** Model provider sink. */
  onRegisterModelProvider?: ((provider: ModelProviderContribution) => void) | undefined;
  /** Repo analyzer sink. */
  onRegisterRepoAnalyzer?: ((analyzer: RepoAnalyzerContribution) => void) | undefined;
  /** Test runner sink. */
  onRegisterTestRunner?: ((runner: TestRunnerContribution) => void) | undefined;
  /** Diff renderer sink. */
  onRegisterDiffRenderer?: ((renderer: DiffRendererContribution) => void) | undefined;
  /** Permission grant resolver. The CLI uses a no-op "deny" by
   *  default; the TUI surfaces a prompt. */
  permissionResolver?: ((p: ExtensionPermission) => Promise<boolean> | boolean) | undefined;
  hasPermission?: ((p: ExtensionPermission) => boolean) | undefined;
}

/**
 * Construct a ReaperExtensionContext bound to a set of sink
 * callbacks. The ExtensionRegistry uses this to wire each
 * `activate()` call to its internal maps.
 */
export function createExtensionContext(opts: ExtensionHostOptions): ReaperExtensionContext {
  const sink: ExtensionLoggerSink = opts.logSink ?? NoopLoggerSink;
  const log: ExtensionLogger = {
    info(msg: string, ...rest: unknown[]) {
      sink.info(formatLog(opts.extensionId, "info", msg, rest));
    },
    warn(msg: string, ...rest: unknown[]) {
      sink.warn(formatLog(opts.extensionId, "warn", msg, rest));
    },
    error(msg: string, ...rest: unknown[]) {
      sink.error(formatLog(opts.extensionId, "error", msg, rest));
    },
  };
  return {
    extensionId: opts.extensionId,
    trust: opts.trust,
    registerTool: (r) => opts.onRegisterTool?.(r),
    registerSkill: (r) => opts.onRegisterSkill?.(r),
    registerSlashCommand: (r) => opts.onRegisterSlashCommand?.(r),
    registerHook: (r) => opts.onRegisterHook?.(r),
    registerPanel: (r) => opts.onRegisterPanel?.(r),
    registerContextProvider: (r) => opts.onRegisterContextProvider?.(r),
    registerModelProvider: (r) => opts.onRegisterModelProvider?.(r),
    registerRepoAnalyzer: (r) => opts.onRegisterRepoAnalyzer?.(r),
    registerTestRunner: (r) => opts.onRegisterTestRunner?.(r),
    registerDiffRenderer: (r) => opts.onRegisterDiffRenderer?.(r),
    log,
    workspace: {
      root: opts.workspaceRoot,
      scratchpad: opts.scratchpadPath,
      extensionInstallPath: opts.extensionInstallPath,
    },
    permissions: {
      request: async (p) => {
        if (opts.permissionResolver) return await opts.permissionResolver(p);
        return false;
      },
      has: (p) => opts.hasPermission?.(p) ?? false,
    },
  };
}

function formatLog(extensionId: string, level: string, msg: string, rest: unknown[]): string {
  const base = `[${extensionId}] ${level}: ${msg}`;
  const withRest = rest.length > 0 ? `${base} ${rest.map(safeStringify).join(" ")}` : base;
  // Always redact secrets in log output.
  const { redacted } = redactSecrets(withRest);
  return redacted;
}

function safeStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const NoopLoggerSink: ExtensionLoggerSink = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Re-export the typed registration shapes so an extension author
// can `import type { ExtensionToolRegistration } from "..."`.
export type {
  ExtensionToolRegistration,
  ExtensionSkillRegistration,
  ExtensionSlashCommandRegistration,
  ExtensionHookRegistration,
  ExtensionPanelRegistration,
} from "./contribution-types.js";
