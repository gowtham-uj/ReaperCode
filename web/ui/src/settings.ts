import { useCallback, useMemo, useState } from "react";

import type { JsonRpcClient } from "@reaper/web-shared";

export type PermissionMode = "yolo" | "accept_edits" | "auto" | "strict";

/**
 * `label` exists because `mode` is a wire identifier, not English:
 * `accept_edits` is not something to show a person, and rendering it verbatim
 * put the one piece of raw protocol vocabulary in the product's UI into the
 * permission picker and the thread settings dialog alike.
 */
export const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; description: string }> = [
  { mode: "yolo", label: "Unattended", description: "Tools run without asking. The default — change it here to be asked." },
  { mode: "accept_edits", label: "Accept edits", description: "File edits run automatically; other actions need approval." },
  { mode: "auto", label: "Balanced", description: "Low-risk actions run automatically; risky ones need approval." },
  { mode: "strict", label: "Strict", description: "Every action needs approval." },
];

/** The mode a fresh install runs in, and the one the picker marks as default. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "yolo";

/** The human label for a mode, falling back to the raw id for unknown values. */
export function permissionLabel(mode: string | undefined): string {
  if (!mode) return "";
  return PERMISSION_MODES.find((candidate) => candidate.mode === mode)?.label ?? mode;
}

export interface ModelRoutingEntry {
  role: string;
  provider: string;
  model: string;
  thinking?: "enabled" | "disabled";
  maxContextTokens?: number;
}

export interface SettingsState {
  fileExists: boolean;
  permissionMode: PermissionMode;
  modelRouting: Record<string, string>;
  models: ModelRoutingEntry[];
  /** Skills whose body rides in every turn, by name. Empty is meaningful. */
  pinnedSkills: string[];
  /** Skills switched off, by name. Empty is meaningful. */
  disabledSkills: string[];
  restartsRequired: boolean;
}

export interface SettingsWriteInput {
  permissionMode?: PermissionMode;
  modelRouting?: Record<string, string>;
  thinking?: { enabled: boolean };
  /**
   * Replace the always-on skill set wholesale.
   *
   * Wholesale rather than add/remove: the set is small and edited as a set, and
   * two RPCs that each flip one member can interleave into a state neither
   * caller asked for.
   */
  pinnedSkills?: string[];
  /**
   * Replace the switched-off skill set wholesale.
   *
   * The inverse of `pinnedSkills` in every respect but the shape: a name here
   * keeps the skill out of the offer, out of the model's reach by activation,
   * and out of the always-on resolution.
   */
  disabledSkills?: string[];
}

export type SkillTrust = "builtin" | "user-trusted" | "project-untrusted" | "extension-inherited" | "draft";

export interface SkillEntry {
  name: string;
  description: string;
  category: string;
  trust: SkillTrust;
  scope: string;
  disabled: boolean;
  disabledReason?: string;
  extensionId?: string;
  validated: boolean;
}

export type ExtensionTrust = "builtin" | "user-trusted" | "project-untrusted";
export type ExtensionStatus = "discovered" | "installed" | "enabled" | "disabled" | "failed";

export interface ExtensionEntry {
  id: string;
  version: string;
  description: string;
  trust: ExtensionTrust;
  status: ExtensionStatus;
  permissions: string[];
  error?: string;
}

export interface ListLoadError { path: string; error: string }
export type PolicyOutcome = "allow" | "deny";
export interface PolicyRule { outcome: PolicyOutcome; pattern: string }
export interface PolicyRulesState { fileExists: boolean; rules: PolicyRule[] }
export interface SettingsStore {
  settings: SettingsState | undefined;
  skills: SkillEntry[];
  skillErrors: ListLoadError[];
  extensions: ExtensionEntry[];
  extensionErrors: ListLoadError[];
  policyRules: PolicyRule[];
  policyFileExists: boolean;
  loading: boolean;
  error: string | undefined;
  refreshSettings(client: JsonRpcClient | undefined): Promise<void>;
  saveSettings(client: JsonRpcClient, input: SettingsWriteInput): Promise<void>;
  refreshSkills(client: JsonRpcClient | undefined, filter?: string): Promise<void>;
  refreshExtensions(client: JsonRpcClient | undefined, filter?: string): Promise<void>;
  refreshPolicy(client: JsonRpcClient | undefined): Promise<void>;
  savePolicy(client: JsonRpcClient, rules: PolicyRule[]): Promise<void>;
}

/** Server-backed settings state shared across all routed Settings sections. */
export function useSettingsStore(): SettingsStore {
  const [settings, setSettings] = useState<SettingsState>();
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillErrors, setSkillErrors] = useState<ListLoadError[]>([]);
  const [extensions, setExtensions] = useState<ExtensionEntry[]>([]);
  const [extensionErrors, setExtensionErrors] = useState<ListLoadError[]>([]);
  const [policyRules, setPolicyRules] = useState<PolicyRule[]>([]);
  const [policyFileExists, setPolicyFileExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refreshSettings = useCallback(async (client: JsonRpcClient | undefined): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      setSettings(await client.call<SettingsState>("settings/read", {}));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  const saveSettings = useCallback(async (client: JsonRpcClient, input: SettingsWriteInput): Promise<void> => {
    await client.call<SettingsState>("settings/write", { ...input });
    await refreshSettings(client);
  }, [refreshSettings]);

  const refreshSkills = useCallback(async (client: JsonRpcClient | undefined, filter?: string): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.call<{ data: SkillEntry[]; errors: ListLoadError[] }>(
        "workspace/skills/list",
        filter ? { filter } : {},
      );
      setSkills(result.data ?? []);
      setSkillErrors(result.errors ?? []);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load skills");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshExtensions = useCallback(async (client: JsonRpcClient | undefined, filter?: string): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.call<{ data: ExtensionEntry[]; errors: ListLoadError[] }>(
        "workspace/extensions/list",
        filter ? { filter } : {},
      );
      setExtensions(result.data ?? []);
      setExtensionErrors(result.errors ?? []);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load extensions");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPolicy = useCallback(async (client: JsonRpcClient | undefined): Promise<void> => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.call<PolicyRulesState>("policy/rules/read", {});
      setPolicyRules(result.rules ?? []);
      setPolicyFileExists(result.fileExists);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load policy rules");
    } finally {
      setLoading(false);
    }
  }, []);

  const savePolicy = useCallback(async (client: JsonRpcClient, rules: PolicyRule[]): Promise<void> => {
    await client.call<PolicyRulesState>("policy/rules/write", { rules });
    await refreshPolicy(client);
  }, [refreshPolicy]);

  return useMemo(() => ({
    settings,
    skills,
    skillErrors,
    extensions,
    extensionErrors,
    policyRules,
    policyFileExists,
    loading,
    error,
    refreshSettings,
    saveSettings,
    refreshSkills,
    refreshExtensions,
    refreshPolicy,
    savePolicy,
  }), [
    settings, skills, skillErrors, extensions, extensionErrors, policyRules,
    policyFileExists, loading, error, refreshSettings, saveSettings,
    refreshSkills, refreshExtensions, refreshPolicy, savePolicy,
  ]);
}
