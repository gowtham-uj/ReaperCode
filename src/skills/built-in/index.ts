/**
 * Public export for the built-in skills root. The path is fixed at
 * compile time; `discoverSkills` walks this directory when given the
 * result of `builtinSkillsRoot()`. Tests and the CLI both use it.
 *
 * In the single-file bundle the skill folders are inlined as a JSON map of
 * `relpath → contents` (injected by esbuild `--define`) and materialized to
 * a temp dir on first call. Outside the bundle the path is the source
 * directory, unchanged.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { bundledSkills } from "../../util/bundled-assets.js";

const here = dirname(fileURLToPath(import.meta.url));

let extractedRoot: string | undefined;

/**
 * Absolute path to the directory holding the built-in skill folders.
 *
 * In a bundle, materialize the inlined `relpath → fileContents` map into
 * `os.tmpdir()/reaper-builtin-skills-<hash>` once and return that. The dir
 * is keyed by the manifest hash so re-extraction is idempotent and stale
 * versions never collide.
 */
export function builtinSkillsRoot(): string {
  const manifest = bundledSkills();
  if (!manifest) return here;
  if (extractedRoot) return extractedRoot;

  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex").slice(0, 12);
  const root = path.join(os.tmpdir(), `reaper-builtin-skills-${digest}`);

  if (!existsSync(root)) {
    for (const [rel, content] of Object.entries(manifest)) {
      const target = path.join(root, rel);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
  }
  extractedRoot = root;
  return root;
}

/** Convenience for `discoverSkills({ builtinRoot: builtinSkillsRoot() })`. */
export const BUILTIN_SKILLS_ROOT_DEFAULT = builtinSkillsRoot();

export { join };
