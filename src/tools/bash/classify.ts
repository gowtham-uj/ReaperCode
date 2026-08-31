export type BashCommandCategory =
  | "read"
  | "write"
  | "install"
  | "network"
  | "git_mutation"
  | "server"
  | "dangerous"
  | "interactive"
  | "unknown";

export interface BashClassification {
  category: BashCommandCategory;
  readOnly: boolean;
  reason: string;
  network: boolean;
}

const READ_COMMANDS = new Set([
  "ls", "ll", "dir", "cat", "head", "tail", "less", "more", "grep", "rg", "ag", "fgrep", "egrep",
  "find", "locate", "which", "type", "command", "wc", "sort", "uniq", "cut", "awk", "sed", "printf",
  "echo", "test", "stat", "file", "id", "pwd", "whoami", "date", "uname", "env", "history",
]);

const GIT_READ_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "branch", "tag", "remote", "config"]);
const SERVER_KEYWORDS = ["node", "python", "http.server", "serve", "dev", "watch", "jest --watch", "vitest --watch"];

function splitShellCommand(command: string): string[] {
  // Minimal, adequate for classification.
  return command
    .replace(/&&/g, " ; ")
    .replace(/\|\|/g, " ; ")
    .replace(/\|/g, " ; ")
    .split(/;\s*/)
    .flatMap((segment) => segment.trim().split(/\s+/))
    .filter(Boolean);
}

const DANGEROUS_PATTERNS = [
  /\(\)\s*\{[^}]*:\s*\|.*;:.*exec\s/i,
  /:\(\)\s*\{/,
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\bdd\s+.*\bof=\/dev\//,
  /\bmkfs\./,
];

export function classifyBashCommand(command: string): BashClassification {
  const lower = command.toLowerCase().trim();
  const words = splitShellCommand(lower);
  const first = words[0] ?? "";

  const hasRedirectOut = />[^=]|[0-9]?>&/.test(command);
  const hasPipe = /\|/.test(command);

  if (DANGEROUS_PATTERNS.some((p) => p.test(lower))) {
    return { category: "dangerous", readOnly: false, reason: "Destructive or denial-of-service command", network: false };
  }

  if (SERVER_KEYWORDS.some((kw) => lower.includes(kw)) && /(--watch|-w)|http.server|serve/.test(lower)) {
    return { category: "server", readOnly: true, reason: "Likely long-running server", network: true };
  }

  if (first === "git") {
    const sub = words[1] ?? "";
    if (["push", "pull", "clone", "fetch", "checkout", "switch", "add", "commit", "restore", "reset", "merge", "rebase"].includes(sub)) {
      return { category: sub === "pull" || sub === "clone" || sub === "fetch" ? "network" : "git_mutation", readOnly: false, reason: `git ${sub}`, network: sub === "pull" || sub === "clone" || sub === "fetch" };
    }
    return { category: "read", readOnly: true, reason: `git ${sub} (read-only)`, network: false };
  }

  if (["npm", "yarn", "pnpm", "bun", "pip", "pip3", "gem", "bundle", "cargo", "go"].includes(first)) {
    const isInstall = /\b(install|add|ci|update|upgrade)\b/.test(lower) || lower === "npm i";
    return { category: isInstall ? "install" : "read", readOnly: !isInstall && !hasRedirectOut, reason: `${first} ${isInstall ? "install" : "command"}`, network: isInstall };
  }

  if (["curl", "wget", "httpie", "fetch"].includes(first)) {
    return { category: "network", readOnly: false, reason: "External network fetch", network: true };
  }

  // In-place editors write the workspace even with no redirection.
  // `sed -i`, `perl -i`, and GNU `awk -i inplace` all rewrite their
  // input files, so they must not fall through to the read allowlist.
  if (hasInPlaceEdit(command)) {
    return { category: "write", readOnly: false, reason: "In-place file edit", network: false };
  }

  if (READ_COMMANDS.has(first) && !hasRedirectOut) {
    return { category: "read", readOnly: true, reason: `read command: ${first}${hasPipe ? " (piped)" : ""}`, network: false };
  }

  if (hasRedirectOut) {
    return { category: "write", readOnly: false, reason: "Contains output redirection", network: false };
  }

  return { category: "unknown", readOnly: false, reason: "Command not classified as read-only", network: false };
}

/**
 * Detect in-place editing invocations. `sed`/`perl` accept `-i`
 * standalone, bundled (`-ni`, `-i.bak`), or as `--in-place`; gawk uses
 * `-i inplace`.
 */
function hasInPlaceEdit(command: string): boolean {
  // `--in-place[=SUFFIX]`, or a short-flag cluster containing `i`
  // (`-i`, `-i.bak`, `-pi`, `-ni`). Over-approximating toward "write"
  // is the safe direction for a read-only classification.
  if (/\b(?:sed|perl)\b[^|;&]*\s--in-place\b/.test(command)) return true;
  if (/\b(?:sed|perl)\b[^|;&]*\s-[A-Za-z]*i(?:[A-Za-z]*|\.\S*)(?:\s|$)/.test(command)) return true;
  if (/\b(?:g?awk)\b[^|;&]*\s-i\s+inplace\b/.test(command)) return true;
  return false;
}

export function isReadOnlyBashCommand(command: string): { allow: boolean; reason: string } {
  const c = classifyBashCommand(command);
  return { allow: c.readOnly, reason: c.reason };
}
