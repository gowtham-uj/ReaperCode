import type { ToolCall } from "../tools/types.js";

export type ExecutionKind = "read" | "write" | "shell_barrier" | "shell_non_barrier";

/**
 * Patterns that always barrier: any command that mutates state, runs tests,
 * invokes package managers, or coordinates with another process.
 */
const barrierCommandPatterns = [
  /\bnpm\b/,
  /\bnpx\b/,
  /\bpnpm\b/,
  /\byarn\b/,
  /\bbun\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\b/,
  /\bmake\b/,
  /\bcmake\b/,
  /\bpip\s+install\b/,
  /\bgit\s+(?:commit|reset|checkout|switch|merge|rebase|push|pull|fetch|clone|stash|tag|rm|mv|restore)\b/,
  /\bnode\b.*\btest\b/,
  /\b(?:nodemon|tsx|ts-node)\b.*\b(?:server|index|app)\.[cm]?[jt]s\b/,
  /\bnode\b\s+(?:(?:index|app|server)\.[cm]?js|(?:server|src|api|backend)\/(?:server|index|app)\.[cm]?js)\b/,
  /\btouch\b/,
  /\bcp\b/,
  /\bmv\b/,
  /\brm\b/,
  /\bmkdir\b/,
  /\bsed\s+-i\b/,
  />\s*\S/,
  /\|\s*\S/,
  /\bcurl\b/,
  /\bwget\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\b(?:python|python3|node|ruby|perl|php)\b\s+(?:-[A-Za-z]+\s+)*-e\b/,
  /\b(?:python|python3|node|ruby|perl|php)\b\s+\S+\.(?:py|js|mjs|cjs|rb|pl|php)\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\b/,
];

/**
 * Read-only allowlist. These commands are guaranteed to be observation
 * only (no filesystem writes, no network, no exec side effects) and can
 * safely run concurrently with other reads.
 */
const readOnlyCommandPrefixes = new Set([
  "ls",
  "pwd",
  "cat",
  "echo",
  "true",
  "false",
  "test",
  "type",
  "which",
  "command",
  "compgen",
  "hash",
  "id",
  "whoami",
  "hostname",
  "date",
  "uname",
  "uptime",
  "env",
  "printenv",
  "set",
  "locale",
  "wc",
  "head",
  "tail",
  "nl",
  "sort",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "stat",
  "file",
  "tree",
  "du",
  "df",
  "free",
  "top",
  "ps",
  "pgrep",
  "pidof",
  "jobs",
  "lsof",
  "tput",
  "help",
  "history",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "column",
  "paste",
  "expand",
  "unexpand",
  "fmt",
  "fold",
  "join",
  "comm",
  "tsort",
]);

/**
 * Detect read-only shell commands by extracting the first command word
 * (after `cd`/`sudo` and variable assignments) and checking an allowlist.
 * Also recognizes simple `head` / `tail` / `cat` with file args, and
 * `git status` / `git log` / `git diff` / `git show` which are read-only.
 */
export function isReadOnlyShellCommand(cmd: string): boolean {
  if (!cmd) return false;
  // Reject obvious write side-effects before any allowlist match.
  if (/[<>]|\|\s*\S|&&|;|\$\(|\beval\b|\bsource\b/.test(cmd)) {
    // `&&` / `;` / `|` / `$()` chain can run mutating commands even if the
    // first command is read-only; be conservative unless the user
    // explicitly opts in.
    return false;
  }
  // Tokenize: strip leading `sudo`, `cd <dir> &&`, env assignments.
  const stripped = cmd
    .replace(/^\s*(?:sudo\s+)?/, "")
    .replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/, "")
    .replace(/^\s*[A-Z_][A-Z0-9_]*=\S*\s+/, "");
  const match = stripped.match(/^\s*(\S+)/);
  if (!match || !match[1]) return false;
  const first = match[1].replace(/^["']|["']$/g, "");
  if (readOnlyCommandPrefixes.has(first)) return true;
  // Read-only `git` subcommands.
  if (first === "git") {
    const sub = stripped.match(/^git\s+(\S+)/)?.[1];
    if (!sub) return false;
    return READ_ONLY_GIT_SUBCOMMANDS.has(sub);
  }
  // `grep` (no `-F` write flag) and `rg` are read-only.
  if ((first === "grep" || first === "rg" || first === "ag") && !/\s--?[a-zA-Z]*[Ww]\b/.test(stripped)) {
    return true;
  }
  // `find` is read-only when no `-exec`, `-delete`, or `-fprint*` flags are present.
  if (first === "find" && !/\s(?:-exec|-ok|-delete|-fprint|-fprintf)\b/.test(stripped)) {
    return true;
  }
  return false;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "branch",
  "tag",
  "remote",
  "rev-parse",
  "describe",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "blame",
  "config",
  "help",
  "version",
  "shortlog",
  "reflog",
  "stash",
  "show-branch",
  "grep",
]);

export function classifyToolCall(call: ToolCall): ExecutionKind {
  if ((call.name as string) === "complete_task") {
    return "shell_barrier";
  }

  if ((call.name as string) === "delegate_to_plan") {
    return "read";
  }

  if (call.name === "get_tool_output") {
    return "read";
  }
  if (
    call.name === "read_file" ||
    call.name === "view_file" ||
    call.name === "file_view" ||
    call.name === "file_scroll" ||
    call.name === "file_find" ||
    call.name === "list_directory" ||
    call.name === "grep_search" ||
    call.name === "git_status" ||
    call.name === "git_diff"
  ) {
    return "read";
  }

  if (
    call.name === "write_file" ||
    call.name === "file_edit" ||
    call.name === "replace_in_file" ||
    call.name === "edit_file" ||
    call.name === "replace_symbol" ||
    call.name === "delete_file" ||
    call.name === "create_checkpoint" ||
    call.name === "restore_checkpoint"
  ) {
    return "write";
  }

  if (call.name === "bash") {
    if (call.args.barrier === true) {
      return "shell_barrier";
    }
    if (call.args.forceNonBarrier === true) {
      return "shell_non_barrier";
    }
    // Default to barrier for unknown shell commands — earlier the default
    // was `shell_non_barrier` which let mutating scripts run concurrently
    // with reads and produce stale observations. Reads now have to be
    // explicitly opted in via the read-only allowlist.
    if (barrierCommandPatterns.some((pattern) => pattern.test(call.args.cmd))) {
      return "shell_barrier";
    }
    if (isReadOnlyShellCommand(call.args.cmd)) {
      return "shell_non_barrier";
    }
    return "shell_barrier";
  }

  if (call.name === "sandbox_service_control") {
    if (["exec", "write_file", "copy_to_service", "restart", "start", "stop"].includes(call.args.action)) {
      return "shell_barrier";
    }
    return "read";
  }

  return "read";
}
