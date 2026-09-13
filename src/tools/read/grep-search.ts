import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath, relativeWorkspacePath } from "../../policy/paths.js";
import { ToolArgumentError, withFileErrors } from "./file-errors.js";

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepSearchResult {
  root: string;
  matches: GrepMatch[];
}

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

/**
 * Compile the search pattern, reporting a malformed one as the model's error.
 *
 * Left alone, `new RegExp` throws a bare `SyntaxError` and the model receives
 * it verbatim: `Invalid regular expression: /(/gm: Unterminated group`. That
 * names neither the tool nor the argument nor the fix, and a model that cannot
 * tell which argument was rejected will usually just retry the same call. The
 * `/gm` in that string is also an implementation detail — the model never
 * asked for flags.
 */
export function compileGrepPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "gm");
  } catch (error) {
    /*
     * Only the trailing clause of Node's message is kept. The full text is
     * `Invalid regular expression: /(/gm: Unterminated group`, and the
     * `/…/gm` in the middle is the *compiled pattern with our own flags* —
     * something the model never wrote and cannot act on. "Unterminated group"
     * is the part that says what is wrong.
     */
    const raw = error instanceof Error ? error.message : String(error);
    const reason = raw.slice(raw.lastIndexOf(": ") + 2).trim() || raw;
    throw new ToolArgumentError(
      `Invalid search pattern ${JSON.stringify(pattern)}: ${reason}. ` +
        "Patterns are JavaScript regular expressions matched per line; escape " +
        "metacharacters such as ( ) [ ] { } + * ? with a backslash to match them literally.",
      "invalid_argument",
    );
  }
}

/**
 * Resolve the `path` argument to the files that should actually be searched,
 * accepting **either a directory or a single file**.
 *
 * `GrepSearchArgsSchema` types `path` as an arbitrary non-empty string and the
 * tool's description is one line — "Search text across files" — so nothing a
 * model can see says a file path is wrong. Passing one is the obvious way to
 * say "search this file", and `walk` then called `readdir` on it
 * unconditionally, so the whole call died with
 * `ENOTDIR: not a directory, scandir '/…/src/legacy.ts'`.
 *
 * That was not hypothetical. In a live run tracing a call chain, the model
 * called `grep_search` with a file path, read the raw errno as a broken tool,
 * reasoned "grep_search fails because it treats path as dir?", and abandoned
 * the call. A valid request that fails with an unreadable error costs more
 * than the one call: it teaches the model the tool is unreliable.
 *
 * A missing path is reported as `not_found` for the same reason, rather than
 * letting ENOENT surface as an errno string.
 */
export async function resolveGrepTargets(root: string, requestedPath: string): Promise<string[]> {
  // `needs` is "file" here only for the wording: this tool is the one that
  // accepts either kind, so an `ENOTDIR` can no longer arise (`stat` has
  // already established the kind before the walk). A missing path still needs
  // to come back as `not_found` rather than an errno string.
  return withFileErrors(
    { requestedPath, needs: "file", instead: "`list_directory` for a directory's contents" },
    async () => {
      const info = await stat(root);
      // A file is a complete answer to "search this path" — search exactly it.
      if (info.isFile()) return [root];
      return walk(root);
    },
  );
}

/**
 * Search `files` for `regex`, returning one match per matching line.
 *
 * Shared by the direct-disk tool and the WAL-aware recovery path so the two
 * cannot drift apart: the WAL copy had the same `path`-must-be-a-directory
 * defect with a worse symptom, because its `walk` swallowed the `readdir`
 * failure and answered `ok: true` with no matches — indistinguishable from a
 * genuine empty result.
 */
export async function collectGrepMatches(
  files: ReadonlyArray<string>,
  regex: RegExp,
  readText: (filePath: string) => Promise<string>,
): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];
  for (const filePath of files) {
    const content = await readText(filePath);
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      regex.lastIndex = 0;
      if (regex.test(line)) {
        matches.push({ path: filePath, line: index + 1, text: line });
      }
    }
  }
  return matches;
}

export async function grepSearchTool(
  workspaceRoot: string,
  args: { pattern: string; path?: string; include?: string },
): Promise<GrepSearchResult> {
  const requestedPath = args.path ?? ".";
  const root = normalizeWorkspacePath(workspaceRoot, requestedPath);
  const regex = compileGrepPattern(args.pattern);
  const includeMatcher = args.include ? globToRegExp(args.include) : undefined;
  const files = await resolveGrepTargets(root, requestedPath);

  // `include` still filters when `path` names a single file. That matches how
  // `grep --include` treats an explicitly named file, and filtering in one
  // place for both shapes keeps the two spellings from disagreeing.
  const searchable = includeMatcher
    ? files.filter((filePath) => includeMatcher.test(relativeWorkspacePath(workspaceRoot, filePath)))
    : files;

  const matches = await collectGrepMatches(searchable, regex, (filePath) => readFile(filePath, "utf8"));

  return { root, matches };
}
