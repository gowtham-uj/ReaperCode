/**
 * run-reaper — entry point for the Reaper CLI.
 *
 * Usage:
 *   reaper                  # default → opens the interactive TUI
 *   reaper tui              # explicit TUI
 *   reaper exec run --prompt "..."
 *   reaper --help
 *
 * If the first non-flag arg is `exec`, `skill`, `memory`, `extensions`,
 * or `tui`, forward the rest to `cli.run()`. Otherwise (bare invocation
 * or top-level flags) default to the TUI for backwards compatibility
 * with the original single-mode entry script.
 */

import path from "node:path";
import { mkdirSync } from "node:fs";

import { ReaperCLI } from "../src/adaptive/cli.js";

const TOP_LEVEL_COMMANDS = new Set([
  "exec",
  "skill",
  "skills",
  "memory",
  "extensions",
  "swarm",
  "visual",
  "capability",
  "redact",
  "slash",
  "tui",
]);

function pickWorkspaceRoot(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && i + 1 < argv.length) {
      return path.resolve(argv[i + 1]!);
    }
  }
  return process.cwd();
}

function stripSelf(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg === "--") continue;
    out.push(arg);
  }
  return out;
}

async function main(): Promise<void> {
  const argv = stripSelf(process.argv.slice(2));

  const workspaceRoot = pickWorkspaceRoot(argv);
  mkdirSync(workspaceRoot, { recursive: true });

  const cli = new ReaperCLI({ workspaceRoot });

  // --help / -h (anywhere in argv) → print usage and exit. Do this
  // BEFORE the TUI default so the user always sees the help text.
  if (argv.includes("--help") || argv.includes("-h")) {
    const result = await cli.run(["--help"]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exit(result.exitCode);
  }

  // First non-flag arg decides the dispatch. With no args, default to TUI
  // (matching the `reaper` → TUI expectation).
  const firstNonFlag = argv.find((a) => !a.startsWith("-"));
  const dispatch = TOP_LEVEL_COMMANDS.has(firstNonFlag ?? "") ? argv : ["tui", ...argv];

  const result = await cli.run(dispatch);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});
