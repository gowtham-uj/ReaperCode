import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../../policy/paths.js";

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if ([".git", "node_modules"].includes(entry.name)) {
          return [] as string[];
        }
        return walk(full);
      }
      return [full];
    }),
  );

  return files.flat();
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export async function grepSearchTool(
  workspaceRoot: string,
  args: { pattern: string; path?: string; include?: string },
) {
  const root = normalizeWorkspacePath(workspaceRoot, args.path ?? ".");
  const regex = new RegExp(args.pattern, "gm");
  const includeMatcher = args.include ? globToRegExp(args.include) : undefined;
  const files = await walk(root);
  const matches: Array<{ path: string; line: number; text: string }> = [];

  for (const filePath of files) {
    const rel = relativeWorkspacePath(workspaceRoot, filePath);
    if (includeMatcher && !includeMatcher.test(rel)) {
      continue;
    }

    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({ path: filePath, line: index + 1, text: line });
      }
    }
  }

  return { root, matches };
}
