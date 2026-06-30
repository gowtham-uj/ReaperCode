/**
 * ExtensionTrustResolver — derives ExtensionTrust from an
 * extension's install path. Mirrors the SkillTrustResolver.
 *
 *   - builtin             shipped under src/extensions/built-in
 *   - user-trusted        ~/.reaper/extensions/<id>
 *   - project-untrusted   <workspace>/.reaper/extensions/<id> (default)
 *
 * Per-extension decisions are cached in `<installDir>/trust.json`
 * so explicit `extensions trust <id>` survives reboots.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import type { ExtensionTrust, ExtensionManifest } from "./types.js";

export interface ExtensionTrustResolverOptions {
  /** Absolute path to the built-in extensions root. */
  builtinRoot: string;
  /** Absolute path to user extensions: ~/.reaper/extensions. */
  userHomeExtensionsDir: string;
  /** Absolute path to project extensions: <workspace>/.reaper/extensions. */
  projectExtensionsDir: string;
}

export interface ExtensionTrustDecision {
  trust: ExtensionTrust;
  reason: string;
  cached: boolean;
}

export interface ExtensionTrustRecord {
  extensionId: string;
  installPath: string;
  trust: ExtensionTrust;
  decidedAt: number;
  decidedBy: "user" | "trust-resolver" | "auto";
  note?: string;
}

export class ExtensionTrustResolver {
  private readonly opts: ExtensionTrustResolverOptions;
  private readonly cache = new Map<string, ExtensionTrustRecord>();

  constructor(opts: ExtensionTrustResolverOptions) {
    this.opts = opts;
  }

  resolve(input: { extensionId: string; installPath: string; declaredTrust?: ExtensionTrust }): ExtensionTrustDecision {
    if (isUnder(input.installPath, this.opts.builtinRoot)) {
      return { trust: "builtin", reason: "path is under built-in root", cached: false };
    }
    const cached = this.loadCached(input.installPath);
    if (cached) {
      return { trust: cached.trust, reason: `stored trust.json: ${cached.note ?? "(no note)"}`, cached: true };
    }
    if (input.declaredTrust) {
      // A fresh install always defaults to the scope's default; declared
      // trust is treated as a *hint* and only honored if the path is in
      // user scope.
      if (isUnder(input.installPath, this.opts.userHomeExtensionsDir)) {
        return { trust: input.declaredTrust, reason: "user-scope install with declared trust", cached: false };
      }
    }
    if (isUnder(input.installPath, this.opts.userHomeExtensionsDir)) {
      return { trust: "user-trusted", reason: "path is under user extensions dir", cached: false };
    }
    if (isUnder(input.installPath, this.opts.projectExtensionsDir)) {
      return { trust: "project-untrusted", reason: "path is under project extensions dir (no trust record)", cached: false };
    }
    return { trust: "project-untrusted", reason: "unknown install path; defaulting to project-untrusted", cached: false };
  }

  promote(extensionId: string, installPath: string, note?: string): ExtensionTrustRecord {
    const record: ExtensionTrustRecord = {
      extensionId,
      installPath,
      trust: "user-trusted",
      decidedAt: Date.now(),
      decidedBy: "user",
      ...(note !== undefined ? { note } : {}),
    };
    this.persist(installPath, record);
    return record;
  }

  demote(extensionId: string, installPath: string, note?: string): ExtensionTrustRecord {
    const record: ExtensionTrustRecord = {
      extensionId,
      installPath,
      trust: "project-untrusted",
      decidedAt: Date.now(),
      decidedBy: "user",
      ...(note !== undefined ? { note } : {}),
    };
    this.persist(installPath, record);
    return record;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private loadCached(installPath: string): ExtensionTrustRecord | null {
    const memo = this.cache.get(installPath);
    if (memo) return memo;
    const file = join(installPath, "trust.json");
    if (!existsSync(file)) return null;
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as ExtensionTrustRecord;
      if (parsed && parsed.installPath === installPath && typeof parsed.trust === "string") {
        this.cache.set(installPath, parsed);
        return parsed;
      }
    } catch { /* ignore */ }
    return null;
  }

  private persist(installPath: string, record: ExtensionTrustRecord): void {
    this.cache.set(installPath, record);
    const file = join(installPath, "trust.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2));
  }
}

function isUnder(child: string, parent: string): boolean {
  const a = child.endsWith(sep) ? child : child + sep;
  const b = parent.endsWith(sep) ? parent : parent + sep;
  return a.startsWith(b);
}

export function reconcileExtensionTrust(declared: ExtensionTrust | undefined, resolved: ExtensionTrust): ExtensionTrust {
  if (resolved === "builtin") return "builtin";
  return resolved;
}
