/**
 * Saved eval scripts, one directory per thread.
 *
 * A model that writes a script worth keeping had nowhere to put it. The program
 * lived inside one tool call, and the next call started from nothing, so a loop
 * that finally got a paginated page right had to be written again the next time
 * the same shape came up. Saving is what turns that work into a tool.
 *
 * ## Why files and not memory
 *
 * The same reason the session journal is a file: a thread outlives the process
 * that served it. A script saved in a map would vanish on the restart that
 * happens between two turns of the same conversation, which is exactly when a
 * model would reach for it again. A directory under the thread's own workspace
 * survives that, is visible in the Files panel, and can be read by the model with
 * an ordinary read tool when it wants to edit one rather than rewrite it.
 *
 * ## Where they live
 *
 * `<workspace>/.reaper/scripts/<name>.js`. Deliberately not in the workspace
 * root: these are Reaper's own artefacts, and a folder of the model's scripts
 * mixed in with the user's code would be both confusing and easy to commit by
 * accident. The `.reaper` directory is already the convention for state that
 * belongs to the tool rather than to the project.
 *
 * ## Why the name is validated
 *
 * It reaches a filename. The schema constrains it to letters, digits, dot, dash
 * and underscore, and this module re-checks before touching the filesystem,
 * because it is also reachable from a caller that did not go through the schema.
 * `..` is refused explicitly rather than by the character class alone: `..` is
 * two dots and passes a per-character test, and it is the one name that escapes
 * the directory.
 */

import { mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Where a thread's scripts live, under its workspace. */
export function scriptsDirectory(workspaceRoot: string): string {
  return join(workspaceRoot, ".reaper", "scripts");
}

/**
 * Whether a name is safe to use as a filename.
 *
 * The character class is the schema's, and `..` is refused on top of it because
 * it satisfies that class while meaning the parent directory.
 */
export function isScriptName(name: string): boolean {
  if (name === "." || name === "..") return false;
  if (name.length === 0 || name.length > 120) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export interface SavedScript {
  name: string;
  path: string;
  bytes: number;
}

/** Every script this thread has saved, newest name first for a stable listing. */
export async function listScripts(workspaceRoot: string): Promise<SavedScript[]> {
  const directory = scriptsDirectory(workspaceRoot);
  const names = await readdir(directory).catch(() => [] as string[]);
  const out: SavedScript[] = [];
  for (const entry of names) {
    if (!entry.endsWith(".js")) continue;
    const name = entry.slice(0, -".js".length);
    if (!isScriptName(name)) continue;
    const contents = await readFile(join(directory, entry), "utf8").catch(() => undefined);
    if (contents === undefined) continue;
    out.push({ name, path: join(directory, entry), bytes: contents.length });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Write a script, replacing one of the same name. */
export async function saveScript(workspaceRoot: string, name: string, code: string): Promise<SavedScript> {
  if (!isScriptName(name)) {
    throw new Error(
      `"${name}" is not a usable script name: use letters, digits, dot, dash and underscore, up to 120 characters`,
    );
  }
  const directory = scriptsDirectory(workspaceRoot);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.js`);
  await writeFile(path, code, { mode: 0o600 });
  return { name, path, bytes: code.length };
}

/**
 * Read a script by name.
 *
 * Returns undefined rather than throwing for "no such script", because that is
 * an ordinary answer and the caller has a better message for it than an
 * exception can give: it can list what does exist.
 */
export async function readScript(workspaceRoot: string, name: string): Promise<{ code: string; path: string } | undefined> {
  if (!isScriptName(name)) return undefined;
  const path = join(scriptsDirectory(workspaceRoot), `${name}.js`);
  const code = await readFile(path, "utf8").catch(() => undefined);
  return code === undefined ? undefined : { code, path };
}

/** Remove a script. Returns whether one was there. */
export async function deleteScript(workspaceRoot: string, name: string): Promise<boolean> {
  if (!isScriptName(name)) return false;
  const path = join(scriptsDirectory(workspaceRoot), `${name}.js`);
  const existed = await readFile(path, "utf8").then(() => true).catch(() => false);
  if (!existed) return false;
  await rm(path, { force: true });
  return true;
}
