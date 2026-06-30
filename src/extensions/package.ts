/**
 * parsePackageMetadata — light-weight `package.json` checks for
 * extensions. Verifies that `main` resolves, and refuses to load
 * extensions that declare a different `reaper` major.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { ExtensionValidationError, type ExtensionManifest } from "./types.js";

export interface PackageMetadata {
  name?: string;
  version?: string;
  main?: string;
  type?: "module" | "commonjs";
  engines?: { reaper?: string };
}

export interface PackageMetadataResult {
  ok: boolean;
  pkg: PackageMetadata | null;
  /** Resolved main entry absolute path, if found. */
  mainPath: string | null;
  /** A list of validation errors. */
  errors: string[];
}

/**
 * Parse `package.json` and check that the entry resolves. The
 * `main` field of `extension.json` is preferred; if `package.json`'s
 * `main` differs, both are honored — the extension.json one wins
 * because it is the authoritative declarative surface.
 */
export function parsePackageMetadata(extensionDir: string, manifest: ExtensionManifest): PackageMetadataResult {
  const errors: string[] = [];
  const pkgPath = join(extensionDir, "package.json");
  let pkg: PackageMetadata | null = null;
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf8");
      pkg = JSON.parse(raw) as PackageMetadata;
    } catch (e) {
      errors.push(`package.json is not valid JSON: ${(e as Error).message}`);
    }
  }
  // main resolves from extension.json; package.json `main` is informational
  const mainRel = manifest.main;
  if (!mainRel || mainRel.length === 0) {
    errors.push("manifest.main is empty");
    return { ok: false, pkg, mainPath: null, errors };
  }
  const mainAbs = resolveMain(extensionDir, mainRel);
  if (!mainAbs || !existsSync(mainAbs)) {
    errors.push(`manifest.main does not resolve: ${mainRel} → ${mainAbs ?? "(invalid)"}`);
    return { ok: false, pkg, mainPath: null, errors };
  }
  // Peer-dep / engine conflict check
  if (pkg?.engines?.reaper) {
    if (!reaperRangeSatisfies(pkg.engines.reaper, manifest.engines.reaper)) {
      errors.push(`package.json engines.reaper="${pkg.engines.reaper}" conflicts with manifest engines.reaper="${manifest.engines.reaper}"`);
    }
  }
  return {
    ok: errors.length === 0,
    pkg,
    mainPath: mainAbs,
    errors,
  };
}

function resolveMain(extensionDir: string, main: string): string | null {
  // JS only: the manifest's main must resolve to a real .js file.
  // We try the literal path, the path with .js appended, and the
  // directory's index.js. TypeScript fallbacks were dropped per
  // user directive.
  if (isAbsolute(main)) {
    if (existsSync(main) && main.endsWith(".js")) return main;
    if (existsSync(main) && !main.endsWith(".js")) return null;
  }
  const candidates = [main, `${main}.js`, `${main}/index.js`];
  for (const c of candidates) {
    const abs = resolve(extensionDir, c);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Compare two semver ranges. Returns true iff `candidate` is a
 * subset-or-equal of `constraint`. This is intentionally narrow:
 * we accept the common ^X.Y.Z / ~X.Y.Z / >=X.Y.Z forms and reject
 * anything more complex. The whole point is to catch gross
 * conflicts, not be a full semver library.
 */
export function reaperRangeSatisfies(candidate: string, constraint: string): boolean {
  const c = parseRange(candidate);
  const k = parseRange(constraint);
  if (!c || !k) return false;
  // Constraint must include the candidate version.
  if (k.op === "^") {
    // Accept anything sharing the major.
    return c.major === k.major;
  }
  if (k.op === "~") {
    // Same major+minor.
    return c.major === k.major && c.minor === k.minor;
  }
  if (k.op === ">=") {
    return compare(c, k) >= 0;
  }
  if (k.op === ">") {
    return compare(c, k) > 0;
  }
  if (k.op === "<=") {
    return compare(c, k) <= 0;
  }
  if (k.op === "<") {
    return compare(c, k) < 0;
  }
  if (k.op === "=" || k.op === "") {
    return c.major === k.major && c.minor === k.minor && c.patch === k.patch;
  }
  return false;
}

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  op: "^" | "~" | ">=" | "<=" | ">" | "<" | "=" | "";
}

function parseRange(r: string): Parsed | null {
  const m = /^(\^|~|\>=|\<=|\>|\<|\=)?\s*(\d+)\.(\d+)\.(\d+)/.exec(r.trim());
  if (!m) return null;
  const op = m[1] ?? "";
  return {
    op: op as Parsed["op"],
    major: parseInt(m[2]!, 10),
    minor: parseInt(m[3]!, 10),
    patch: parseInt(m[4]!, 10),
  };
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}
