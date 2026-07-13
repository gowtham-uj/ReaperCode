/**
 * provider-onboarding.ts — persisted provider + API key + model selection.
 *
 * The list of supported providers is data-driven from
 * `src/model/provider/catalog.ts`. To onboard a new provider, add a
 * row to the catalog — this file does not need to change.
 *
 * What it does:
 *   1. Expose the catalog-backed provider list for pickers/CLIs.
 *   2. Persist `{provider, envVar, apiKey, model}` to
 *      `~/.reaper/onboarding.json` with 0600 permissions, and seed
 *      `process.env[envVar] = apiKey` so the rest of the runtime
 *      picks it up uniformly with the env-var path.
 *
 * Skip conditions (env already provides auth):
 *   - any catalog env var (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 *     MINIMAX_API_KEY, DEEPSEEK_API_KEY, CEREBRAS_API_KEY,
 *     OPENROUTER_API_KEY) is set in `process.env`, OR
 *   - `~/.reaper/onboarding.json` exists and has a non-empty
 *     `apiKey` (we re-use the saved one).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

import { PROVIDER_CATALOG } from "./provider/catalog.js";
import { listProvidersForOnboarding } from "./provider/registry.js";

/**
 * The legacy string-literal type preserved for backwards
 * compatibility with the `onboarding.json` file format. Any
 * catalog id works at runtime; this union is purely historical.
 */
export type SupportedProviderId = string;

export interface SupportedProvider {
  id: SupportedProviderId;
  /** User-facing label in the picker. */
  label: string;
  /** Env var the runtime reads for the API key. */
  envVar: string;
  /** Base URL the runtime should use (for reference + display). */
  baseUrl: string;
  /** Provider-specific model catalogue. */
  models: string[];
  /** Hint shown beneath the key prompt. */
  keyHint: string;
}

/**
 * The catalog-backed provider list. Adding a vendor to the catalog
 * automatically adds it here.
 */
export const SUPPORTED_PROVIDERS: SupportedProvider[] =
  listProvidersForOnboarding().map((p) => ({
    id: p.id,
    label: p.label,
    envVar: p.envVar,
    baseUrl: p.baseUrl,
    models: p.models,
    keyHint: p.keyHint,
  }));

export interface OnboardingState {
  provider: SupportedProviderId;
  envVar: string;
  apiKey: string;
  model: string;
  /** ISO timestamp of when this was saved. */
  savedAt: string;
}

const FILE_PATH = join(homedir(), ".reaper", "onboarding.json");

/**
 * Read the saved onboarding state, or return null if missing/malformed.
 * Never throws — onboarding is best-effort.
 */
export function loadOnboarding(): OnboardingState | null {
  try {
    if (!existsSync(FILE_PATH)) return null;
    const raw = readFileSync(FILE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (
      typeof parsed.provider === "string" &&
      typeof parsed.envVar === "string" &&
      typeof parsed.apiKey === "string" &&
      typeof parsed.model === "string" &&
      parsed.apiKey.length > 0
    ) {
      return {
        provider: parsed.provider as SupportedProviderId,
        envVar: parsed.envVar,
        apiKey: parsed.apiKey,
        model: parsed.model,
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist onboarding state. Creates the parent dir, writes 0600.
 * Also seeds process.env so downstream reads pick it up.
 */
export function saveOnboarding(state: Omit<OnboardingState, "savedAt">): void {
  const dir = dirname(FILE_PATH);
  mkdirSync(dir, { recursive: true });
  const full: OnboardingState = { ...state, savedAt: new Date().toISOString() };
  writeFileSync(FILE_PATH, JSON.stringify(full, null, 2), "utf8");
  try {
    chmodSync(FILE_PATH, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  process.env[state.envVar] = state.apiKey;
}

/**
 * Remove the saved onboarding file. Also unsets the env vars.
 */
export function clearOnboarding(): void {
  try {
    if (existsSync(FILE_PATH)) unlinkSync(FILE_PATH);
  } catch {
    /* ignore */
  }
  // Wipe every catalog-known provider env var so a re-run starts
  // from a clean slate. Backed by PROVIDER_CATALOG.
  for (const p of PROVIDER_CATALOG) {
    if (process.env[p.envVar]) {
      delete process.env[p.envVar];
    }
  }
}

/**
 * Returns the auth token for the chosen provider, preferring env
 * vars over the saved file. Used by exec-runner / gateway code paths
 * to look up a key when one isn't already in process.env.
 */
export function resolveProviderKey(provider: SupportedProviderId): string | undefined {
  const def = PROVIDER_CATALOG.find((p) => p.id === provider);
  if (!def) return undefined;
  const envVal = process.env[def.envVar];
  if (envVal && envVal.trim().length > 0) return envVal;
  const saved = loadOnboarding();
  if (saved && saved.provider === provider) return saved.apiKey;
  return undefined;
}

/**
 * True if the user has already provided credentials for at least
 * one supported provider.
 */
export function hasAnyAuth(): boolean {
  for (const p of PROVIDER_CATALOG) {
    const v = process.env[p.envVar];
    if (v && v.trim().length > 0) return true;
  }
  const saved = loadOnboarding();
  return saved !== null && saved.apiKey.length > 0;
}

/**
 * Seed process.env from the saved onboarding file. Called once at
 * CLI startup so that the rest of the runtime (gateway, exec-runner)
 * can read `process.env[<envVar>]` uniformly.
 */
export function seedEnvFromOnboarding(): OnboardingState | null {
  const saved = loadOnboarding();
  if (!saved) return null;
  if (!process.env[saved.envVar] || process.env[saved.envVar]?.trim() === "") {
    process.env[saved.envVar] = saved.apiKey;
  }
  return saved;
}
