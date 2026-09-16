/**
 * Paths inside `.reaper/` that turn a file write into code that runs.
 *
 * ## Why this exists
 *
 * The approval gates on `extension_manager create` and `hook_manager create`
 * were the front door, and they were locked. The side door was `write_file`,
 * which has no gate at all: dropping a hook JSON into `.reaper/hooks/` reaches
 * the same loader `create_hook` uses, and `hook_manager list` calls
 * `discover()`, which compiles and registers every file it finds. So the model
 * did not need the manager tools to get code running in Reaper's process; it
 * needed one file write.
 *
 * That is worse than a bypass, because it is invisible: nothing in the
 * transcript records a hook being created, `hook_manager list` would show the
 * file as if it had always been there, and the code runs on the next matching
 * tool call. The audit confirmed the whole chain, including that uninstall left
 * it running.
 *
 * ## What this guards, and what it deliberately does not
 *
 * Guarding all of `.reaper/` would be simpler and would be wrong: the agent
 * legitimately writes there, and the runtime keeps its own state there
 * (`.reaper/sessions`, `.reaper/checkpoints`, `.reaper/logs`). A blanket block
 * would break the tools that use those directories to do their job.
 *
 * So the list is the directories whose *contents are loaded as code or as
 * instructions*, which is exactly the set where writing a file is equivalent to
 * asking for something to run. Everything else under `.reaper/` stays writable.
 */

import path from "node:path";

import { ToolArgumentError } from "../tools/read/file-errors.js";

/**
 * Directories under `.reaper/` whose contents are loaded and executed.
 *
 * Each entry is a path relative to the workspace root, and each has a reason:
 *
 *   - `hooks` run in-process on every matching tool call.
 *   - `extensions` are imported as modules into the same process.
 *   - `skills` are read as instructions the model follows, so a skill body is
 *     prompt injection with a filename.
 *   - `linters` supply a manifest that `file_edit` uses to `require()` a
 *     package in-process, which the audit reproduced as host code execution.
 *   - `extensions-builtin` is loaded the same way as `extensions`.
 */
const CODE_LOADING_DIRS: ReadonlyArray<readonly string[]> = [
  ["hooks"],
  ["extensions"],
  ["extensions-builtin"],
  ["skills"],
  ["linters"],
];

/**
 * Single files under `.reaper/` whose contents change what is trusted.
 *
 * `trust.json` records that an extension was approved and `project-trust.json`
 * records that a workspace was. Writing either is granting a permission, which
 * is the one thing a model must not be able to do for itself.
 */
const TRUST_FILES: ReadonlyArray<string> = ["trust.json", "project-trust.json"];

/**
 * Whether a path is one the agent must not create or overwrite directly.
 *
 * Returns the offending relative path when it is, so the caller can name it in
 * the error rather than making the model guess which part of a long path
 * tripped the rule.
 */
export function codeLoadingPath(workspaceRoot: string, filePath: string): string | undefined {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  // Outside the workspace entirely: that is `normalizeWorkspacePath`'s job, and
  // this check is not a second boundary.
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;

  const segments = relative.split(path.sep);
  if (segments[0] !== ".reaper") return undefined;

  /*
   * The project's `.reaper`, not the user's home one. A user-scope hook under
   * `~/.reaper/hooks` is outside the workspace and unaffected by this rule,
   * which is correct: it is the user's own file, not something the agent can
   * reach with `write_file` in the first place.
   */
  const withinReaper = segments.slice(1);
  for (const dir of CODE_LOADING_DIRS) {
    if (withinReaper.length >= dir.length && dir.every((segment, index) => withinReaper[index] === segment)) {
      return relative;
    }
  }
  if (withinReaper.length === 1 && TRUST_FILES.includes(withinReaper[0]!)) return relative;
  return undefined;
}

/**
 * Refuse a write that would put code or a trust decision in place.
 *
 * Thrown as `ToolArgumentError` so it arrives as a `tool_error` naming the path
 * and the reason, which is what the model needs to stop reaching for the
 * workaround and use the manager tool that asks the user instead.
 */
export function assertNotCodeLoadingPath(workspaceRoot: string, filePath: string): void {
  const offending = codeLoadingPath(workspaceRoot, filePath);
  if (offending === undefined) return;
  throw new ToolArgumentError(
    `write_file: refusing to write '${offending}'. Files here are loaded and run by Reaper, so writing one is ` +
      `equivalent to installing code, and it bypasses the approval that exists for exactly that. Use ` +
      `hook_manager, extension_manager or skill_manager, which ask the user first.`,
    "invalid_argument",
  );
}
