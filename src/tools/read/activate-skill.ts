import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";

import { readDisabledSkills } from "../../context/pinned-skills.js";
import { SkillMemoryRegistry } from "../../adaptive/skill-memory-registry.js";
import { builtinSkillsRoot } from "../../skills/built-in/index.js";
import { discoverSkills, readDisabledMarker } from "../../skills/discovery.js";
import { TrustResolver } from "../../skills/trust.js";
import type { InstalledSkillRecord } from "../../skills/types.js";

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

export function activationSkillDirs(
  workspaceRoot: string,
  userHome = os.homedir(),
): string[] {
  // Keep activation aligned with discovery and preserve its precedence:
  // project overrides user, and an explicitly packaged built-in is the
  // final fallback. The built-in root is intentionally empty today.
  return [
    path.join(workspaceRoot, ".reaper", "skills"),
    path.join(userHome, ".reaper", "skills"),
    builtinSkillsRoot(),
  ];
}

/**
 * Look a skill up in the on-disk discovery walk.
 *
 * `SkillMemoryRegistry` is the older, persisted half of the system: it is
 * synced from discovery by whoever boots a `SkillRegistry`, and the CLI is
 * currently the only thing that does. A long-lived app-server therefore holds
 * an index snapshot taken whenever a CLI last ran, so a skill that ships with
 * the product — or one added to `~/.reaper/skills` since — is *on disk and
 * discoverable* while the index has never heard of it. Going to the source
 * removes the boot-order dependency without removing the allowlist: the walk
 * only ever yields folders with a valid `skill.json`, which is exactly the
 * gate the registry was there to provide.
 */
function findDiscoveredSkill(workspaceRoot: string, name: string): { record: InstalledSkillRecord; filePath: string } | null {
  const userHome = os.homedir();
  const projectSkillsDir = path.join(workspaceRoot, ".reaper", "skills");
  const userHomeSkillsDir = path.join(userHome, ".reaper", "skills");
  const builtinRoot = builtinSkillsRoot();
  const discovered = discoverSkills({
    builtinRoot,
    userHomeSkillsDir,
    projectSkillsDir,
    workspaceRoot,
    resolver: new TrustResolver({ builtinRoot, userHomeSkillsDir, projectSkillsDir }),
    // A skill the user switched off must not be activatable by name from the
    // model. Without this the settings list would only affect what is offered
    // — and a model that remembers a name from an earlier turn could still
    // pull the body.
    disabledNames: new Set(readDisabledSkills()),
  });
  const record = discovered.records.find((entry) => entry.manifest.name === name);
  if (!record) return null;
  // The body lives at `<skillDir>/SKILL.md`. Reading it through the record's
  // own directory (rather than re-resolving by name) means the file we open is
  // the one discovery actually accepted.
  return { record, filePath: path.join(record.skillDir, "SKILL.md") };
}

export async function activateSkillTool(workspaceRoot: string, args: { name: string }) {
  const name = validateSkillName(args?.name);
  const skillDirs = activationSkillDirs(workspaceRoot);

  /*
   * Registry allowlist: a skill must be registered before we will hand back
   * its body. This prevents a model from activating arbitrary markdown that
   * happens to live on disk. The index is consulted first because it carries
   * the persisted disable/trust state; discovery is the fallback for a skill
   * that exists on disk but predates the last index sync.
   */
  /*
   * Both index roots, not just the project one.
   *
   * `SkillMemoryRegistry.load()` returns the *first* index it finds and
   * `skill_manager create` writes to the **user** index (`~/.reaper/skills/`).
   * Constructing this without `userHome` meant the registry read only
   * `<workspace>/.reaper/skills/index.json` — so a skill created a moment
   * earlier was absent from the very registry activation consults, and the
   * model got "not registered in the SkillMemoryRegistry" for something it had
   * just successfully created.
   *
   * Passing `userHome` puts both writers and this reader on the same two files.
   */
  const registry = new SkillMemoryRegistry({
    workspaceRoot,
    ...(process.env.HOME ? { userHome: process.env.HOME } : {}),
  });

  /*
   * The user's own switch, checked first and independently of both paths below.
   *
   * This has to be a separate check rather than folded into the record flags,
   * because the two sources of truth disagree by construction: the settings
   * list is written by `skill disable` in this process's settings file, while
   * `SkillMemoryRegistry` serves `disableModelInvocation` from an index that
   * was synced earlier — often by a different process, often before the user
   * switched the skill off. Guarding only the discovered path left the hole
   * that mattered: a skill present in the index took the `registered` branch
   * and its body was returned even with the name sitting in the disabled list.
   */
  if (readDisabledSkills().includes(name)) {
    throw new Error(`Skill '${name}' is switched off in Reaper's settings and cannot be activated.`);
  }

  const registered = registry.getSkill(name);
  const discovered = registered ? null : findDiscoveredSkill(workspaceRoot, name);

  if (!registered && !discovered) {
    throw new Error(
      `Skill '${name}' is not registered in the SkillMemoryRegistry. ` +
        `Only skills registered in the registry may be activated.`,
    );
  }

  // Model-invocation guard: disableModelInvocation is the canonical
  // field; disableAutoInvocation is the legacy alias. If either is
  // set, refuse to surface the body to the model. The flag encodes
  // both trust (untrusted skills are persisted with it set) and an
  // explicit `skill disable`.
  if (registered && (registered.disableModelInvocation === true || registered.disableAutoInvocation === true)) {
    throw new Error(
      `Skill '${name}' has disableModelInvocation=true and cannot be activated.`,
    );
  }

  /*
   * The same guard for the discovery path, derived from the record rather than
   * from the index: trust below accepted, or an explicit disable, means the
   * body is not model-readable. This is the rule `recordToReaperSkill` applies
   * when it syncs an index entry, applied one step earlier.
   */
  if (discovered) {
    const { record } = discovered;
    const accepted = record.trust === "builtin" || record.trust === "user-trusted" || record.trust === "extension-inherited";
    if (record.disabled === true || !accepted) {
      throw new Error(`Skill '${name}' has disableModelInvocation=true and cannot be activated.`);
    }
  }

  const resolved = discovered
    ? { filePath: discovered.filePath, realPath: await realpath(discovered.filePath) }
    : await resolveSkillFile(name, skillDirs);
  if (!resolved) {
    throw new Error(
      `Skill '${name}' is registered in the registry but no on-disk file was found ` +
        `in any of the skill directories: ${skillDirs.join(", ")}.`,
    );
  }
  // A discovered record's path is trusted because discovery built it from the
  // walk's own roots; a name-resolved path is not, and keeps its symlink check.
  if (discovered) await assertInsideAllowedDirs(resolved.realPath, skillDirs);

  // Defense-in-depth: honor the on-disk `disabled` marker even if the
  // registry index has not been re-synced since the disable. The
  // marker lives in the skill's own folder, which we just resolved.
  const marker = readDisabledMarker(path.dirname(resolved.realPath));
  if (marker !== null) {
    throw new Error(
      `Skill '${name}' is disabled and cannot be activated (${marker}).`,
    );
  }

  const content = await readFile(resolved.filePath, "utf8");
  return `<activated_skill>\n<instructions>\n${stripFrontmatter(content)}\n</instructions>\n</activated_skill>`;
}
