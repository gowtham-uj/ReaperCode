import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

import { SkillMemoryRegistry } from "../../adaptive/skill-memory-registry.js";

/**
 * Simple frontmatter stripper.
 */
function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return normalized;
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return normalized;
  }

  return normalized.slice(endIndex + 5).trim();
}

/**
 * S1 hardening: validate the skill name before any I/O.
 *
 * Rules:
 *   - must be a non-empty string
 *   - must be a relative path (no leading slash)
 *   - must not contain path separators (no /, no \)
 *   - must not be a relative-path component (no leading ., no ..)
 */
function validateSkillName(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("Skill name must be a non-empty string.");
  }
  if (path.isAbsolute(raw)) {
    throw new Error("Skill name must be relative (no leading slash or drive letter).");
  }
  if (raw.includes("/") || raw.includes("\\")) {
    throw new Error("Skill name must not contain path separators.");
  }
  if (raw === "." || raw === ".." || raw.startsWith(".")) {
    throw new Error("Skill name must not be a relative-path component (no leading '.' or '..').");
  }
  return raw;
}

/**
 * Verify that `candidate` (a realpath-resolved path) lives inside one
 * of the allowed `skillDirs` (also realpath-resolved). Rejects paths
 * that escape the workspace via symlinks.
 */
async function assertInsideAllowedDirs(
  candidate: string,
  allowedDirs: string[],
): Promise<void> {
  for (const dir of allowedDirs) {
    let dirReal: string;
    try {
      dirReal = await realpath(dir);
    } catch {
      continue;
    }
    if (candidate === dirReal) {
      throw new Error(
        `Skill path '${candidate}' resolves to an allowed skill directory itself; refusing.`,
      );
    }
    if (candidate.startsWith(dirReal + path.sep)) {
      return;
    }
  }
  throw new Error(
    `Skill path '${candidate}' is outside the allowed skill directories.`,
  );
}

/**
 * Resolve the on-disk file for `name`, given the configured skill
 * directories. Returns the absolute path of the file to read, or null
 * if no candidate exists.
 *
 * Resolution order (per directory):
 *   1. <dir>/<name>.md
 *   2. <dir>/<name>/SKILL.md
 *   3. <dir>/<name>/README.md
 *   4. <dir>/<name>/<first *.md>
 *
 * Symlink-escape detection: every resolved file is realpath-checked
 * against the allowed skill directories.
 */
async function resolveSkillFile(
  name: string,
  skillDirs: string[],
): Promise<{ filePath: string; realPath: string } | null> {
  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;

    const base = path.join(dir, name);
    const candidates: string[] = [];

    const asFile = `${base}.md`;
    if (existsSync(asFile)) candidates.push(asFile);

    if (existsSync(base)) {
      const skillMd = path.join(base, "SKILL.md");
      const readmeMd = path.join(base, "README.md");
      if (existsSync(skillMd)) {
        candidates.push(skillMd);
      } else if (existsSync(readmeMd)) {
        candidates.push(readmeMd);
      } else {
        try {
          const files = await readdir(base);
          const mdFile = files.find((f) => f.endsWith(".md"));
          if (mdFile) candidates.push(path.join(base, mdFile));
        } catch {
          // ignore unreadable directories
        }
      }
    }

    for (const candidate of candidates) {
      let real: string;
      try {
        real = await realpath(candidate);
      } catch {
        continue;
      }
      await assertInsideAllowedDirs(real, skillDirs);
      return { filePath: candidate, realPath: real };
    }
  }
  return null;
}

export async function activateSkillTool(workspaceRoot: string, args: { name: string }) {
  const name = validateSkillName(args?.name);

  const skillDirs = [
    path.join(workspaceRoot, ".opencode", "skills"),
    path.join(workspaceRoot, ".reaper", "skills"),
    path.join(workspaceRoot, ".pi", "skills"),
    path.join(workspaceRoot, "skills"),
  ];

  // Registry allowlist: a skill must be registered before we will
  // hand back its body. This prevents a model from activating
  // arbitrary markdown that happens to live on disk.
  const registry = new SkillMemoryRegistry({ workspaceRoot });
  const registered = registry.getSkill(name);
  if (!registered) {
    throw new Error(
      `Skill '${name}' is not registered in the SkillMemoryRegistry. ` +
        `Only skills registered in the registry may be activated.`,
    );
  }

  // Model-invocation guard: disableModelInvocation is the canonical
  // field; disableAutoInvocation is the legacy alias. If either is
  // set, refuse to surface the body to the model.
  if (registered.disableModelInvocation === true || registered.disableAutoInvocation === true) {
    throw new Error(
      `Skill '${name}' has disableModelInvocation=true and cannot be activated.`,
    );
  }

  const resolved = await resolveSkillFile(name, skillDirs);
  if (!resolved) {
    throw new Error(
      `Skill '${name}' is registered in the registry but no on-disk file was found ` +
        `in any of the skill directories: ${skillDirs.join(", ")}.`,
    );
  }

  const content = await readFile(resolved.filePath, "utf8");
  return `<activated_skill>\n<instructions>\n${stripFrontmatter(content)}\n</instructions>\n</activated_skill>`;
}
