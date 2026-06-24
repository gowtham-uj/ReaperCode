import path from "node:path";

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export function normalizeWorkspacePath(workspaceRoot: string, targetPath: string): string {
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

  return resolved;
}

function rewriteWorkspaceAliasPath(root: string, targetPath: string): string {
  if (!path.isAbsolute(targetPath)) return targetPath;

  const aliases = (process.env.REAPER_WORKSPACE_PATH_ALIASES ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  if (process.env.REAPER_TBENCH_CONTAINER_NAME && !aliases.includes("/app")) {
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
