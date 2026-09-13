/**
 * Settings surface — the app-server's allowlisted read/write view of the
 * current user's universal Reaper settings.
 *
 * Two invariants govern everything here:
 *
 *  1. **Secrets never leave this module.** `settings/read` returns a fixed,
 *     allowlisted shape (roles, providers, model names, the thinking knob, the
 *     permission default). The raw config object — which could carry keys this
 *     schema does not know — is never returned to a client.
 *  2. **Writes round-trip the raw object, never the parsed one.** Config is
 *     mutated in place on a JSON-level copy so unknown keys survive verbatim,
 *     and the merged result is re-validated against `ReaperConfigSchema`
 *     before it touches disk. A write that would produce an invalid config
 *     refuses to write anything.
 *
 * Browser settings are server-wide rather than thread-scoped. The message
 * processor applies permission changes to every stored thread immediately;
 * provider credentials are resolved afresh at each turn. Legacy model-routing
 * fields remain in the allowlisted shape for non-browser clients.
 */

import { homedir } from "node:os";

import { isPlainObject, readRawUserSettings, updateUserSettings } from "../config/settings-file.js";
import { MAX_DISABLED_SKILLS, MAX_PINNED_SKILLS, normalizePinnedNames } from "../context/pinned-skills.js";
import type { PermissionMode } from "../policy/classifier.js";
import { resolveEffectivePermissionMode } from "../policy/mode.js";

export interface SettingsModelSummary {
  role: string;
  provider: string;
  model: string;
  thinking?: "enabled" | "disabled";
  maxContextTokens?: number;
}

export interface SettingsReadResult {
  fileExists: boolean;
  /** The global permission default (`runtimeTunables.permissionMode`). */
  permissionMode: PermissionMode;
  /** Route → role map from `modelRouting`. */
  modelRouting: Record<string, string>;
  /** One entry per configured model profile. */
  models: SettingsModelSummary[];
  /** Skills whose body rides in every turn (`runtimeTunables.pinnedSkills`). */
  pinnedSkills: string[];
  /** Skills the user has switched off (`runtimeTunables.disabledSkills`). */
  disabledSkills: string[];
  /** Browser-facing settings are applied by the app-server immediately. */
  restartsRequired: boolean;
}

export interface SettingsWriteParams {
  /** Set the global permission default. */
  permissionMode?: PermissionMode | undefined;
  /** Replace entries in the route → role map. */
  modelRouting?: Record<string, string> | undefined;
  /** Toggle the DeepSeek thinking channel on every deepseek profile. */
  thinking?: { enabled: boolean } | undefined;
  /**
   * Replace the pinned-skill set wholesale.
   *
   * Wholesale rather than add/remove because pinning is a small set a person
   * edits as a set, and two RPCs that each mutate one member can interleave
   * into a state neither caller asked for. An empty array is meaningful — it
   * unpins everything — which is why the "at least one change" refinement
   * checks for `undefined` and not for falsiness.
   */
  pinnedSkills?: string[] | undefined;
  /**
   * Replace the switched-off set wholesale.
   *
   * Wholesale for the same reason as `pinnedSkills`: it is a small set edited
   * as a set, and per-member mutation from two clients can interleave into a
   * state neither asked for. An empty array means "nothing is switched off".
   */
  disabledSkills?: string[] | undefined;
}

/**
 * How many skills one user may pin.
 *
 * A bound rather than a policy: every pin costs its whole body on every turn,
 * so an unbounded list is an unbounded standing prompt. Fifty is far more than
 * anyone wants — the feature is for the handful of skills that are simply true
 * — and it exists so that a scripted client cannot make every turn carry
 * megabytes.
 *
 * Defined next to the turn path that pays the cost, and re-exported here only
 * so the RPC's bound and the file's bound cannot drift apart.
 */
export { MAX_DISABLED_SKILLS, MAX_PINNED_SKILLS };

export interface SettingsStoreOptions {
  /** Injectable for tests. Production defaults to the operating-system user home. */
  home?: string;
}

function settingsHome(options: SettingsStoreOptions): string {
  return options.home ?? homedir();
}

/**
 * `~/.reaper/settings.json` is a **partial**, not a whole engine config.
 *
 * A file containing only `runtimeTunables` is valid user settings even though
 * `ReaperConfigSchema` would reject it as a standalone runtime config because
 * `models` has no default. Read the raw object structurally, return only the
 * allowlisted fields this browser surface understands, and ignore everything
 * else.
 */
export function readSettings(_workspaceRoot: string, options: SettingsStoreOptions = {}): SettingsReadResult {
  const { raw, fileExists } = readRawUserSettings(settingsHome(options));

  const tunables = isPlainObject(raw.runtimeTunables) ? raw.runtimeTunables : {};
  const routing = isPlainObject(raw.modelRouting) ? raw.modelRouting : {};
  const rawModels = isPlainObject(raw.models) ? raw.models : {};

  const modelRouting: Record<string, string> = {};
  for (const [route, role] of Object.entries(routing)) {
    if (typeof role === "string") modelRouting[route] = role;
  }

  const models: SettingsModelSummary[] = Object.entries(rawModels)
    .filter((entry): entry is [string, Record<string, unknown>] => isPlainObject(entry[1]))
    .map(([role, profile]) => {
      const defaultParams = isPlainObject(profile.defaultParams) ? profile.defaultParams : {};
      const capabilities = isPlainObject(profile.capabilities) ? profile.capabilities : {};
      const thinking = defaultParams.thinking;
      const maxContextTokens = capabilities.maxContextTokens;
      return {
        role,
        provider: typeof profile.provider === "string" ? profile.provider : "unknown",
        model: typeof profile.model === "string" ? profile.model : "unknown",
        ...(thinking === "enabled" || thinking === "disabled"
          ? { thinking: thinking as "enabled" | "disabled" }
          : {}),
        ...(typeof maxContextTokens === "number" ? { maxContextTokens } : {}),
      };
    })
    .sort((a, b) => a.role.localeCompare(b.role));

  return {
    fileExists,
    permissionMode: resolveEffectivePermissionMode(tunables.permissionMode),
    modelRouting,
    models,
    /*
     * Normalised on the way *out* as well as on the way in, because this reads
     * a file a human may have edited by hand: the browser then shows what the
     * turn will actually do, rather than what the file happens to contain.
     * Same function the turn path uses, so the two cannot disagree about what
     * a pin is.
     */
    pinnedSkills: normalizePinnedNames(tunables.pinnedSkills),
    disabledSkills: normalizePinnedNames(tunables.disabledSkills),
    restartsRequired: false,
  };
}

export function writeSettings(workspaceRoot: string, input: SettingsWriteParams, options: SettingsStoreOptions = {}): SettingsReadResult {
  updateUserSettings(settingsHome(options), (before) => {
    const next: Record<string, unknown> = { ...before };

    if (input.permissionMode !== undefined) {
      next.runtimeTunables = {
        ...(isPlainObject(before.runtimeTunables) ? before.runtimeTunables : {}),
        permissionMode: input.permissionMode,
      };
    }

    if (input.modelRouting !== undefined) {
      next.modelRouting = {
        ...(isPlainObject(before.modelRouting) ? before.modelRouting : {}),
        ...input.modelRouting,
      };
    }

    if (input.pinnedSkills !== undefined) {
      next.runtimeTunables = {
        ...(isPlainObject(next.runtimeTunables) ? next.runtimeTunables : {}),
        /*
         * Normalised again here even though the RPC schema already bounded the
         * list, because the schema is deliberately looser: it caps the count
         * and each name's length, but a name that is only whitespace would
         * survive `.min(1)` and then never match a skill. Dropping those means
         * the file on disk and the browser's view of it cannot disagree.
         */
        pinnedSkills: normalizePinnedNames(input.pinnedSkills).slice(0, MAX_PINNED_SKILLS),
      };
    }

    if (input.disabledSkills !== undefined) {
      next.runtimeTunables = {
        ...(isPlainObject(next.runtimeTunables) ? next.runtimeTunables : {}),
        disabledSkills: normalizePinnedNames(input.disabledSkills).slice(0, MAX_DISABLED_SKILLS),
      };
    }

    if (input.thinking !== undefined) {
      const existing = isPlainObject(before.models) ? before.models : {};
      const updated: Record<string, unknown> = {};
      for (const [role, profile] of Object.entries(existing)) {
        if (!isPlainObject(profile)) {
          updated[role] = profile;
          continue;
        }
        if (profile.provider !== "deepseek") {
          updated[role] = profile;
          continue;
        }
        const defaultParams = isPlainObject(profile.defaultParams) ? profile.defaultParams : {};
        updated[role] = {
          ...profile,
          defaultParams: { ...defaultParams, thinking: input.thinking.enabled ? "enabled" : "disabled" },
        };
      }
      next.models = updated;
    }

    return next;
  });

  return readSettings(workspaceRoot, options);
}
