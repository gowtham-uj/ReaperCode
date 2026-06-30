/**
 * Public export for the built-in skills root. The path is fixed at
 * compile time; `discoverSkills` walks this directory when given the
 * result of `builtinSkillsRoot()`. Tests and the CLI both use it.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the directory holding the 17 built-in skill folders. */
export function builtinSkillsRoot(): string {
  return here;
}

/** Convenience for `discoverSkills({ builtinRoot: builtinSkillsRoot() })`. */
export const BUILTIN_SKILLS_ROOT_DEFAULT = builtinSkillsRoot();

export { join };
