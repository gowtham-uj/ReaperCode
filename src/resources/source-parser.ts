import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NpmResourceSource {
  type: "npm";
  spec: string;
  name: string;
  version: string | undefined;
  pinned: boolean;
}

export interface GitResourceSource {
  type: "git";
  repo: string;
  host: string;
  path: string;
  ref: string | undefined;
  pinned: boolean;
}

export interface LocalResourceSource {
  type: "local";
  path: string;
}

export type ResourceSource = NpmResourceSource | GitResourceSource | LocalResourceSource;

export function parseResourceSource(source: string): ResourceSource | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("npm:")) {
    return parseNpmSource(trimmed.slice("npm:".length).trim());
  }

  if (isLocalSource(trimmed)) {
    return { type: "local", path: normalizeLocalPath(trimmed) };
  }

  return parseGitSource(trimmed);
}

export function resolveResourcePath(input: string, baseDir: string = process.cwd()): string {
  const normalized = normalizeLocalPath(input);
  const expanded = normalized === "~" || normalized.startsWith(`~${path.sep}`) || normalized.startsWith("~/")
    ? path.join(homedir(), normalized.slice(2))
    : normalized;
  return path.resolve(baseDir, expanded);
}

export function canonicalizeResourcePath(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return input;
  }
}

export function sourceMatchKeyForInput(source: string): string | null {
  const parsed = parseResourceSource(source);
  if (!parsed) return null;
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${canonicalizeResourcePath(resolveResourcePath(parsed.path))}`;
}

export function sourceMatchKeyForSettings(source: string, baseDir: string): string | null {
  const parsed = parseResourceSource(source);
  if (!parsed) return null;
  if (parsed.type === "npm") return `npm:${parsed.name}`;
  if (parsed.type === "git") return `git:${parsed.host}/${parsed.path}`;
  return `local:${canonicalizeResourcePath(resolveResourcePath(parsed.path, baseDir))}`;
}

function parseNpmSource(spec: string): NpmResourceSource | null {
  if (!spec) return null;
  const { name, version } = splitNpmSpec(spec);
  if (!name) return null;
  return {
    type: "npm",
    spec,
    name,
    version,
    pinned: Boolean(version && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)),
  };
}

function splitNpmSpec(spec: string): { name: string; version: string | undefined } {
  const trimmed = spec.trim();
  if (trimmed.startsWith("@")) {
    const slash = trimmed.indexOf("/");
    if (slash < 0) return { name: trimmed, version: undefined };
    const versionAt = trimmed.indexOf("@", slash + 1);
    if (versionAt < 0) return { name: trimmed, version: undefined };
    return { name: trimmed.slice(0, versionAt), version: trimmed.slice(versionAt + 1) || undefined };
  }
  const versionAt = trimmed.indexOf("@");
  if (versionAt < 0) return { name: trimmed, version: undefined };
  return { name: trimmed.slice(0, versionAt), version: trimmed.slice(versionAt + 1) || undefined };
}

function isLocalSource(value: string): boolean {
  if (/^file:\/\//i.test(value)) return true;
  if (value.startsWith("git:")) return false;
  if (/^(https?|ssh|git):\/\//i.test(value)) return false;
  if (/^git@[^:]+:.+/.test(value)) return false;
  if (/^[^/\s]+\.[^/\s]+\/.+/.test(value)) return false;
  return true;
}

function normalizeLocalPath(value: string): string {
  if (/^file:\/\//i.test(value)) {
    return fileURLToPath(value);
  }
  return value;
}

function parseGitSource(source: string): GitResourceSource | null {
  const trimmed = source.trim();
  const withoutPrefix = trimmed.startsWith("git:") && !trimmed.startsWith("git://")
    ? trimmed.slice("git:".length).trim()
    : trimmed;
  if (!withoutPrefix || withoutPrefix.startsWith("/")) return null;

  const split = splitGitRef(withoutPrefix);
  const repoWithoutRef = split.repo;
  const ref = split.ref;

  const scp = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const host = scp[1] ?? "";
    const repoPath = normalizeGitPath(scp[2] ?? "");
    return buildGitSource({ repo: `git@${host}:${repoPath}`, host, repoPath, ref });
  }

  if (/^(https?|ssh|git):\/\//i.test(repoWithoutRef)) {
    try {
      const url = new URL(repoWithoutRef);
      const host = url.hostname;
      const repoPath = normalizeGitPath(url.pathname.replace(/^\/+/, ""));
      if (!repoPath) return null;
      url.pathname = `/${repoPath}`;
      url.search = "";
      url.hash = "";
      return buildGitSource({ repo: url.toString().replace(/\/$/, ""), host, repoPath, ref });
    } catch {
      return null;
    }
  }

  const slash = repoWithoutRef.indexOf("/");
  if (slash < 0) return null;
  const host = repoWithoutRef.slice(0, slash);
  const repoPath = normalizeGitPath(repoWithoutRef.slice(slash + 1));
  if (!host.includes(".") && host !== "localhost") return null;
  return buildGitSource({ repo: `https://${host}/${repoPath}`, host, repoPath, ref });
}

function splitGitRef(value: string): { repo: string; ref: string | undefined } {
  if (/^git@[^:]+:.+/.test(value)) {
    const colon = value.indexOf(":");
    const prefix = value.slice(0, colon + 1);
    const rest = value.slice(colon + 1);
    const at = rest.indexOf("@");
    if (at < 0) return { repo: value, ref: undefined };
    return { repo: `${prefix}${rest.slice(0, at)}`, ref: rest.slice(at + 1) || undefined };
  }

  if (/^(https?|ssh|git):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const rawPath = url.pathname.replace(/^\/+/, "");
      const at = rawPath.indexOf("@");
      if (at < 0) return { repo: value, ref: undefined };
      const ref = rawPath.slice(at + 1) || undefined;
      url.pathname = `/${rawPath.slice(0, at)}`;
      url.search = "";
      url.hash = "";
      return { repo: url.toString().replace(/\/$/, ""), ref };
    } catch {
      return { repo: value, ref: undefined };
    }
  }

  const slash = value.indexOf("/");
  if (slash < 0) return { repo: value, ref: undefined };
  const host = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  const at = rest.indexOf("@");
  if (at < 0) return { repo: value, ref: undefined };
  return { repo: `${host}/${rest.slice(0, at)}`, ref: rest.slice(at + 1) || undefined };
}

function normalizeGitPath(repoPath: string): string {
  return repoPath.replace(/\.git$/, "").replace(/^\/+/, "");
}

function buildGitSource(input: { repo: string; host: string; repoPath: string; ref: string | undefined }): GitResourceSource | null {
  const repoPath = normalizeGitPath(input.repoPath);
  if (!input.host || !repoPath || repoPath.split("/").length < 2) return null;
  if (hasUnsafeGitInstallPart(input.host, false) || hasUnsafeGitInstallPart(repoPath, true)) return null;
  return {
    type: "git",
    repo: input.repo,
    host: input.host,
    path: repoPath,
    ref: input.ref,
    pinned: Boolean(input.ref),
  };
}

function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
  const decoded = decodeForValidation(value);
  if (decoded === null) return true;
  for (const candidate of [value, decoded]) {
    if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) return true;
    if (!allowSlash && candidate.includes("/")) return true;
    if (candidate.split("/").includes("..")) return true;
  }
  return false;
}

function decodeForValidation(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
