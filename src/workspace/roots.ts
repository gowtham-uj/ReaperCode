import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { getSandboxTunables } from "../config/config-tunables.js";


export async function countFileLines(
  workspaceRoot: string,
  targetPath: string,
  recoverySession?: { wal: { readText(path: string): Promise<string> } },
): Promise<number> {
  const normalizedTargetPath = rewriteWorkspaceAliasPath(workspaceRoot, targetPath);
  const content = recoverySession
    ? await recoverySession.wal.readText(normalizedTargetPath)
    : await readFile(path.isAbsolute(normalizedTargetPath) ? normalizedTargetPath : new URL(normalizedTargetPath, `file://${workspaceRoot}/`), "utf8");
  return content.split(/\r?\n/).length;
}

export async function discoverWorkspaceRoots(baseDir: string, maxDepth = 2): Promise<string[]> {
  const roots = new Set<string>();
  
  async function search(currentDir: string, depth: number) {
    try {
      const gitDir = path.join(currentDir, ".git");
      const gitStat = await stat(gitDir).catch(() => null);
      if (gitStat?.isDirectory() || gitStat?.isFile()) {
        roots.add(currentDir);
        return; // Don't search inside a repository for sub-repositories by default to keep it simple, or maybe we do?
      }

      if (depth >= maxDepth) return;

      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".reaper" && entry.name !== "scratchpad") {
          await search(path.join(currentDir, entry.name), depth + 1);
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  await search(path.resolve(baseDir), 0);
  
  const result = [...roots];
  if (result.length === 0) {
    result.push(path.resolve(baseDir)); // Default to base dir if no git root found
  }
  return result;
}

export function findOwningRoot(roots: string[], targetPath: string): string {
  const primaryRoot = roots[0] ? path.resolve(roots[0]) : process.cwd();
  const resolved = path.resolve(rewriteWorkspaceAliasPath(primaryRoot, targetPath));
  
  // Sort roots by length descending to match the deepest/most specific root first
  const sortedRoots = [...roots].sort((a, b) => b.length - a.length);
  
  for (const root of sortedRoots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return root;
    }
  }
  
  throw new Error(`Path '${targetPath}' is outside all configured workspace roots.`);
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
