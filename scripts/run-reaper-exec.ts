/**
 * One-shot entrypoint that wires ReaperCLI.exec run --provider minimax.
 *
 * Usage:
 *   node --import tsx scripts/run-reaper-exec.ts \
 *     --prompt 'go to microsoft.com and take a screenshot of the home page and save it in /tmp/test-screenshot' \
 *     --workspace /tmp/test-screenshot
 *
 * Forwards argv past "--" into ReaperCLI.run so the same flags the
 * CLI documents (--prompt, --workspace, --provider, --json, --timeout-ms,
 * --max-tokens) all work without any extra parsing.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { ReaperCLI } from "../src/adaptive/cli.js";

function stripSelf(argv: string[]): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    filtered.push(arg);
  }
  return filtered;
}

async function main(): Promise<void> {
  const argv = stripSelf(process.argv.slice(2));
  // Find --workspace so we can build the workspace before running.
  let workspaceRoot = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--workspace" && i + 1 < argv.length) {
      workspaceRoot = path.resolve(argv[i + 1]!);
      break;
    }
  }
  mkdirSync(workspaceRoot, { recursive: true });

  const cli = new ReaperCLI({ workspaceRoot });
  const result = await cli.run(["exec", "run", ...argv]);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(2);
});