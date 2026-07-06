import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { getSandboxTunables } from "../config/config-tunables.js";


export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export interface NormalizeOptions {
  /**
   * If true, resolve symlinks and reject paths whose real path escapes the
   * workspace root. Defaults to true — Reaper treats the workspace root as a
   * hard sandbox boundary and does not let the model read or write through
   * symlinks that point outside. Pass `false` only for internal callers that
   * have already validated the path's real location (e.g. the bash tool's
   * workspace-relative command parser).
   */
  forbidSymlinkEscape?: boolean;
}

export function normalizeWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
  options: NormalizeOptions = {},
): string {
  const forbidSymlinkEscape = options.forbidSymlinkEscape !== false;
  const root = path.resolve(workspaceRoot);

  const aliasedTargetPath = rewriteWorkspaceAliasPath(root, targetPath);

  // If targetPath is absolute, ensure it's a child of root
  const resolved = path.isAbsolute(aliasedTargetPath)
    ? path.resolve(aliasedTargetPath)
    : path.resolve(root, aliasedTargetPath);

  const isExactlyRoot = resolved === root;
  const isInsideRoot = resolved.startsWith(`${root}${path.sep}`);

  if (!isExactlyRoot && !isInsideRoot) {
    throw new PathPolicyError(`Path '${targetPath}' escapes workspace root '${root}'`);
  }

  if (forbidSymlinkEscape) {
    let real: string;
    try {
      // lstatSync returns metadata without following symlinks, so we can
      // detect the link itself and realpathSync only fires when needed.
      const stats = lstatSync(resolved);
      if (stats.isSymbolicLink()) {
        real = realpathSync(resolved);
      } else {
        real = resolved;
      }
    } catch (error) {
      // ENOENT — file does not exist yet. Walk up to find the nearest existing
      // ancestor, realpath it, then re-apply the suffix. This catches the
      // common "creating a new file under a symlinked parent dir" case.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        real = resolveNewFileRealpath(resolved);
      } else {
        throw error;
      }
    }
    const realIsExactlyRoot = real === root;
    const realIsInsideRoot = real.startsWith(`${root}${path.sep}`);
    if (!realIsExactlyRoot && !realIsInsideRoot) {
      throw new PathPolicyError(
        `Path '${targetPath}' resolves through a symlink to '${real}', which escapes workspace root '${root}'`,
      );
    }
  }

  return resolved;
}

function resolveNewFileRealpath(target: string): string {
  // Walk up until we find an existing ancestor, realpath it, then re-attach
  // the missing tail. This handles writes under symlinked parent dirs whose
  // own target is outside the workspace.
  let cursor = target;
  while (cursor !== path.dirname(cursor)) {
    try {
      const realCursor = realpathSync(cursor);
      const suffix = path.relative(cursor, target);
      return suffix ? path.join(realCursor, suffix) : realCursor;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw error;
      }
      cursor = path.dirname(cursor);
    }
  }
  return target;
}

function rewriteWorkspaceAliasPath(root: string, targetPath: string): string {
  if (!path.isAbsolute(targetPath)) return targetPath;

  const aliases = (getSandboxTunables().workspacePathAliases ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  if (getSandboxTunables().tbenchContainerName && !aliases.includes("/app")) {
    aliases.unshift("/app");
  }

  for (const alias of aliases) {
    const normalizedAlias = path.resolve(alias);
    const normalizedTarget = path.resolve(targetPath);
    if (normalizedTarget === normalizedAlias) return root;
    if (normalizedTarget.startsWith(`${normalizedAlias}${path.sep}`)) {
      return path.join(root, path.relative(normalizedAlias, normalizedTarget));
    }
  }

  return targetPath;
}

export function relativeWorkspacePath(workspaceRoot: string, targetPath: string): string {
  return path.relative(path.resolve(workspaceRoot), targetPath) || ".";
}
