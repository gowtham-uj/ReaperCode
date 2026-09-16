/**
 * The read-only dependency mount Code Mode needs to import a package.
 *
 * A script runs inside a bubblewrap namespace that contains the thread's
 * workspace and the read-only system directories, and nothing else. That is the
 * confinement working: a path outside the workspace does not resolve, which is
 * how a script cannot read Reaper's own source or another thread's files.
 *
 * The cost is that Reaper's `node_modules` is outside the workspace too, so
 * `require('playwright')` fails with `MODULE_NOT_FOUND` — verified, and the
 * reason this file exists. Binding the directory in read-only is the smallest
 * change that keeps the confinement intact: the script can load the package but
 * cannot rewrite it, so one script cannot alter the library the next one loads.
 *
 * `NODE_PATH` is what actually makes it resolvable. `require` and `import()`
 * both consult it after their own directory walk finds nothing, and the walk
 * cannot succeed here because neither the worker (`<workspace>/__codemode__.js`)
 * nor the relay (`<workspace>/.reaper/sandbox/codemode/relay.cjs`) sits under a
 * directory that contains a `node_modules`.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxBind } from "../../policy/shell-sandbox.js";

/**
 * Where the harness's dependencies are mounted inside the namespace.
 *
 * A fixed, short path rather than the real one. The real repository path can be
 * arbitrarily deep, and a mount point nobody types is one nobody accidentally
 * writes to.
 */
export const SANDBOX_DEPENDENCY_PATH = "/reaper-deps/node_modules";

/**
 * Find the `node_modules` directory that satisfies this module's own imports.
 *
 * Resolved by walking up from `import.meta.url` rather than from `process.cwd()`
 * or an environment variable, because the answer has to be the directory Node
 * would use for `src/tools/code/transport.ts` itself — anything else is a guess
 * that happens to work in one layout. The walk stops at the first `node_modules`
 * that exists, which for an installed package is the one beside it and for this
 * checkout is `<repo>/node_modules`.
 *
 * Returns undefined when none is found, which is the bundled-binary case: the
 * single-file build inlines its dependencies and has no `node_modules` to
 * mount, so the caller simply does not add the bind.
 */
export function resolveDependencyRoot(startUrl: string = import.meta.url): string | undefined {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(startUrl));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(dir, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The bind that makes packages importable, or an empty array when there is
 * nothing to mount.
 *
 * Empty rather than a thrown error: a binary build with no `node_modules` should
 * still run evals, it just cannot import third-party packages, which is the
 * behaviour it had before this existed.
 */
export function dependencyBinds(startUrl: string = import.meta.url): SandboxBind[] {
  const root = resolveDependencyRoot(startUrl);
  if (!root) return [];
  return [{ source: root, target: SANDBOX_DEPENDENCY_PATH, readOnly: true }];
}
