/**
 * What kind of thing a tool is, and how the transcript should draw it.
 *
 * One mapping, in one file, because the alternative was measured and it was
 * bad: the tool-name lists were duplicated across `toolGlyph`, `stepGlyph`,
 * `stepLabel` and `resultNote`, four lists that had to agree and did not. A new
 * search tool got a magnifying glass from one of them and a step titled
 * "Reading" from another, and nothing failed — the transcript was just quietly
 * wrong about what had happened.
 *
 * Categories rather than one entry per tool. A reader scanning a transcript is
 * looking for "a search" or "a write", not for `apply_patch_edit` specifically,
 * and thirty distinct glyphs would be a legend to learn. It also means a tool
 * this build has never heard of still lands somewhere sensible: the name is
 * matched by shape (`*_search`, `read_*`, `*_edit`) before falling back to the
 * generic category, so a plugin's `notion_search` gets the search treatment
 * without anyone adding it here.
 */

import type { IconName } from "./tool-icons.js";

/**
 * A category and an icon are the same list, so they are the same type. Adding a
 * category without drawing its icon is then a compile error rather than a box
 * glyph nobody noticed until a screenshot.
 */
export type ToolCategory = IconName;

export interface ToolPresentation {
  category: ToolCategory;
  /** Which icon the tile draws. Same key as the category, kept for readability at call sites. */
  icon: IconName;
  /**
   * Whether a count of result lines is worth showing on the folded row.
   *
   * True only where the count is the finding. "8 matches" beside a search is
   * the single most useful thing on a folded row; "412 lines" beside a file
   * read is filler, and a row of filler is worse than a row without it.
   */
  countsResults: boolean;
  /** How a step made mostly of this category is titled when the model did not say. */
  stepLabel: string;
  /**
   * How much visual weight the action carries.
   *
   * `light` actions (reads, searches, listings) are the bulk of a long run and
   * stay one line unless something went wrong. `rich` actions (edits, commands,
   * eval) are what the run was for, so they may open themselves and show a
   * body. The transcript reads this rather than testing for tool names.
   */
  weight: "light" | "rich";
}

const CATEGORIES: Record<ToolCategory, Omit<ToolPresentation, "category">> = {
  search: { icon: "search", countsResults: true, stepLabel: "Searching", weight: "light" },
  read: { icon: "read", countsResults: false, stepLabel: "Reading", weight: "light" },
  list: { icon: "list", countsResults: true, stepLabel: "Exploring the repository", weight: "light" },
  edit: { icon: "edit", countsResults: false, stepLabel: "Editing files", weight: "rich" },
  command: { icon: "command", countsResults: false, stepLabel: "Running commands", weight: "rich" },
  test: { icon: "test", countsResults: false, stepLabel: "Running tests", weight: "rich" },
  eval: { icon: "eval", countsResults: false, stepLabel: "Running code", weight: "rich" },
  agent: { icon: "agent", countsResults: false, stepLabel: "Delegating", weight: "rich" },
  web: { icon: "web", countsResults: true, stepLabel: "Looking things up", weight: "light" },
  browser: { icon: "browser", countsResults: false, stepLabel: "Driving the browser", weight: "rich" },
  config: { icon: "config", countsResults: false, stepLabel: "Changing configuration", weight: "light" },
  generic: { icon: "generic", countsResults: false, stepLabel: "Working", weight: "light" },
};

/**
 * Exact names first, because a name this build ships is not a guess.
 *
 * Only Reaper's own tools belong here. Everything else is matched by shape
 * below, which is what keeps this table from becoming the thing it replaced.
 */
const BY_NAME: Record<string, ToolCategory> = {
  file_view: "read",
  skim_file: "read",
  read_file: "read",
  view_file: "read",
  grep_search: "search",
  file_find: "search",
  glob: "search",
  search_tools: "search",
  search_memory: "search",
  list_directory: "list",
  write_file: "edit",
  file_edit: "edit",
  edit_file: "edit",
  apply_patch_edit: "edit",
  apply_patch: "edit",
  delete_file: "edit",
  bash: "command",
  job: "command",
  eval: "eval",
  web_search: "web",
  web_fetch: "web",
  browser_use: "browser",
  skill_manager: "config",
  extension_manager: "config",
  hook_manager: "config",
  activate_skill: "config",
  scratchpad: "generic",
  create_checkpoint: "generic",
  restore_checkpoint: "generic",
};

/**
 * Name shapes, for tools this build has never seen.
 *
 * Ordered: the first match wins, so `run_tests` is a test rather than a command
 * even though it contains neither word exactly. Deliberately conservative —
 * anything that does not match a shape gets the generic treatment, which is a
 * neutral glyph and a one-line row, and that is a perfectly good outcome.
 */
const BY_SHAPE: Array<[RegExp, ToolCategory]> = [
  [/(^|_)(test|tests|spec|pytest|jest|vitest)($|_)/, "test"],
  [/(^|_)(grep|search|find|glob|ripgrep|rg)($|_)/, "search"],
  [/(^|_)(read|view|cat|open|show|skim)($|_)/, "read"],
  [/(^|_)(ls|list|tree|dir)($|_)/, "list"],
  [/(^|_)(edit|write|patch|apply|create|delete|remove|rename|move)($|_)/, "edit"],
  [/(^|_)(bash|sh|shell|exec|run|command|terminal)($|_)/, "command"],
  [/(^|_)(eval|code|script|python|node)($|_)/, "eval"],
  [/(^|_)(agent|task|delegate|subagent|spawn)($|_)/, "agent"],
  [/(^|_)(browser|page|click|navigate|screenshot)($|_)/, "browser"],
  [/(^|_)(web|http|fetch|url|curl|request)($|_)/, "web"],
  [/(^|_)(config|setting|skill|hook|extension|manager)($|_)/, "config"],
];

/** How the transcript should draw a call to this tool. */
export function getToolPresentation(tool: string): ToolPresentation {
  const name = tool.toLowerCase();
  const exact = BY_NAME[name];
  if (exact) return { category: exact, ...CATEGORIES[exact] };
  for (const [shape, category] of BY_SHAPE) {
    if (shape.test(name)) return { category, ...CATEGORIES[category] };
  }
  return { category: "generic", ...CATEGORIES.generic };
}

/** The presentation for a category directly, for the non-tool item kinds. */
export function presentationFor(category: ToolCategory): ToolPresentation {
  return { category, ...CATEGORIES[category] };
}

/**
 * Whether a shell command is a test run.
 *
 * Used only to pick the glyph and the step's title. It does not change what the
 * card reports: parsing "18 passed" out of arbitrary test output would be
 * inventing a result, and a wrong count is worse than no count.
 *
 * The word has to be the *program being run*, not a word that happens to appear
 * in the command. Matching any occurrence anywhere made a search for a test
 * fixture a "test run":
 *
 *   grep -rn "reconcileTrust" /work/src /work/tests | grep -v node_modules
 *
 * is a search, it draws a magnifying glass's worth of meaning, and it was
 * labelled "Running tests" with a test-tube glyph because `/work/tests` is a
 * path with the word in it. Two of the five recorded misfires in one real
 * session were commands whose only sin was grepping a directory named `tests`,
 * and `--no-tests` or `npm ls jest` misfire the same way.
 *
 * So the word is looked for where a command actually names what it runs: as the
 * leading token, or right after a runner that takes a subcommand (`npm test`,
 * `yarn test`, `pnpm test`, `bun test`), or as a runner invocation whose own
 * name carries the intent (`jest`, `vitest`, `pytest`, `mocha`, `go test`,
 * `cargo test`). A path, a flag, or an argument cannot reach it.
 */
export function isTestCommand(command: string): boolean {
  /*
   * Matched by tokenising, not by searching for the word.
   *
   * The question is always "what program does this command run", and that is a
   * property of the command's first token, not of any word anywhere in the
   * string. Searching produced the misfires this replaces: `/work/tests` in a
   * grep, `jest` in `npm ls jest`, and `.test.ts` in a filename are all the
   * word "test" appearing where it does not name a program.
   *
   * So each command in the line is looked at, its leading wrappers and any
   * directory prefix are stripped, and the program that remains is checked
   * against the runners this build knows. A path or a flag can never satisfy
   * that, and a wrapper cannot hide what it invokes.
   */
  const RUNNERS = new Set(["jest", "vitest", "pytest", "mocha", "ava", "tap", "rspec", "phpunit"]);
  const PACKAGE_MANAGERS = new Set(["npm", "yarn", "pnpm", "bun"]);
  /** Invoke whatever follows, so they are transparent to this question. */
  const WRAPPERS = new Set(["sudo", "time", "exec", "command", "env", "nice", "doas"]);
  /** A runner by itself, or the word that asks a package manager for one. */
  const isRunnerWord = (word: string): boolean => RUNNERS.has(word) || word === "test";

  /** The bare name of a token, with any directory prefix removed. */
  const basename = (token: string): string => token.split("/").pop() ?? token;

  /** Skip a token that is a wrapper flag or a `NAME=value` environment prefix. */
  const isWrapperArgument = (token: string): boolean =>
    token.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

  /**
   * Whether one command, already split from its chain, is a test run.
   *
   * Walks the tokens rather than anchoring a pattern, because the answer
   * depends on which token is the program and what the ones after it mean:
   * `npx` and `sudo` hand off to the next token, `npm`/`yarn`/`pnpm` take a
   * subcommand (`npm test`, or `npm run test`), and everything else either is
   * a runner or is not.
   */
  const segmentIsTestRun = (segment: string): boolean => {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (isWrapperArgument(token)) { index += 1; continue; }
      const program = basename(token);
      if (WRAPPERS.has(program)) {
        index += 1;
        // `nice -n 10`, `sudo -u root`: the wrapper's own arguments are not the
        // program, so they are consumed with it.
        while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
        continue;
      }
      if (program === "npx") {
        // `npx vitest run` runs vitest, so the next real token is the program.
        index += 1;
        while (index < tokens.length && tokens[index]!.startsWith("-")) index += 1;
        continue;
      }
      if (PACKAGE_MANAGERS.has(program)) {
        let next = index + 1;
        if (tokens[next] === "run") next += 1;
        const subcommand = tokens[next];
        return subcommand !== undefined && isRunnerWord(basename(subcommand));
      }
      if (program === "go" || program === "cargo") return tokens[index + 1] === "test";
      return isRunnerWord(program);
    }
    return false;
  };

  /*
   * Split on every shell separator, so `npm run lint && npm test` is two
   * commands and the second one is seen. Splitting rather than anchoring is
   * what lets a test run in the middle of a chain count.
   */
  return command
    .toLowerCase()
    .split(/&&|\|\||[;&|(\n]/)
    .some(segmentIsTestRun);
}
