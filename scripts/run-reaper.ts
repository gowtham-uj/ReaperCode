/**
 * run-reaper — entry point for the Reaper CLI.
 *
 * Usage:
 *   reaper exec run --prompt "..."
 *   reaper --help
 *
 * The first non-flag arg picks the command group and the rest is
 * forwarded to `cli.run()`. Bare invocations print usage — the Pi
 * TUI is the interactive cockpit for Reaper.
 */

import path from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

function loadEnvFiles(): void {
  const candidates = [
    path.join(process.env.HOME ?? "~", ".reaper", ".env"),
    path.join(process.env.HOME ?? "~", ".hermes", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        let trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trim();
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      // ignore read errors
    }
  }
}

loadEnvFiles();

import { ReaperCLI } from "../src/adaptive/cli.js";

const TOP_LEVEL_COMMANDS = new Set([
  "exec",
  "skill",
  "skills",
  "memory",
  "extensions",
  "visual",
  "capability",
  "redact",
  "slash",
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

  // --help / -h (anywhere in argv) → print usage and exit.
  if (argv.includes("--help") || argv.includes("-h")) {
    const result = await cli.run(["--help"]);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exit(result.exitCode);
  }

  // First non-flag arg decides the dispatch. With no recognized command,
  // print usage — the Pi TUI is the interactive cockpit for Reaper.
  const firstNonFlag = argv.find((a) => !a.startsWith("-"));
  const dispatch = TOP_LEVEL_COMMANDS.has(firstNonFlag ?? "") ? argv : ["--help"];

  const result = await cli.run(dispatch);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});
