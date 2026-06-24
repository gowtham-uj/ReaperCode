/**
 * Typed contribution handlers — what an extension registers in
 * `activate(ctx)`. Each one is a small interface so the host (CLI
 * or TUI) can call them with type safety.
 *
 * These are the *contracts* the host receives from extensions.
 * The `host.ts` module exposes `ReaperExtensionContext` which lets
 * an extension register instances of these interfaces.
 */

import type { ToolMetadata } from "../governance/tool-metadata.js";
import type { SkillManifest } from "../skills/types.js";
import type { HookEventName } from "./types.js";

export interface SlashCommandArgSpec {
  name: string;
  description: string;
  required?: boolean;
}

export type SlashCommandResult =
  | { ok: true; output: string; data?: unknown }
  | { ok: false; output: string; error: string };

export type SlashCommandHandler = (
  args: string[],
  ctx: { commandName: string; host: { print(msg: string): void; printError(msg: string): void } },
) => Promise<SlashCommandResult> | SlashCommandResult;

export interface ContextProviderContribution {
  name: string;
  scope: "project" | "user";
  /** Returns the provider's contribution as text. May be empty. */
  provide: () => Promise<string> | string;
}

export interface ModelProviderContribution {
  name: string;
  /** Identifier / fingerprint of the model provider — opaque to the host. */
  describe: () => { providerId: string; modelAliases: string[] };
}

export interface RepoAnalyzerContribution {
  name: string;
  /** Inspect the workspace at `workspaceRoot` and return a one-line summary. */
  analyze: (workspaceRoot: string) => Promise<string> | string;
}

export interface TestRunnerContribution {
  name: string;
  command: string;
  /** Run the test command in `cwd`. */
  run: (cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface DiffRendererContribution {
  name: string;
  /** Render a unified diff to a human-readable string. */
  render: (diff: string) => string;
}

/**
 * What an extension's `activate(ctx)` registers. The `host.ts`
 * `registerTool` signature requires the metadata + the handler in
 * one call so the policy gate sees metadata on first call.
 */
export interface ExtensionToolRegistration {
  name: string;
  description: string;
  schema?: Record<string, unknown> | undefined;
  metadata: ToolMetadata;
  handler: (args: Record<string, unknown>, ctx: { extensionId: string; toolName: string; callId?: string }) => Promise<unknown> | unknown;
}

/** Hook registration. */
export interface ExtensionHookRegistration {
  event: HookEventName;
  handler: (event: { name: HookEventName; payload: Record<string, unknown>; blockable: boolean }) => Promise<{ allow: boolean; message?: string; reason?: string }> | { allow: boolean; message?: string; reason?: string };
  timeoutMs?: number;
}

/** Slash command registration. */
export interface ExtensionSlashCommandRegistration {
  name: string;
  description: string;
  args?: SlashCommandArgSpec[];
  hidden?: boolean;
  handler: SlashCommandHandler;
}

/** Skill registration. */
export interface ExtensionSkillRegistration {
  manifest: SkillManifest;
  /** Optional body; if omitted, the host reads SKILL.md from disk. */
  body?: string;
}

/** Panel registration (TUI-side). The host ignores this in the CLI. */
export interface ExtensionPanelRegistration {
  name: string;
  title: string;
  render: (ctx: { width: number; height: number }) => string;
}
