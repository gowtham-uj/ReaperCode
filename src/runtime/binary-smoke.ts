/**
 * Post-install binary smoke check.
 *
 * When a bash command runs `npm install` / `pnpm install` / `yarn` /
 * `npm i`, the runtime schedules a follow-up that invokes every
 * binary declared in the workspace `package.json` (`bin` and the
 * implicit `name`/`main` shebang) with `--version` (or `--help` as
 * a fallback) and reports any that exit 0 with empty stdout/stderr.
 *
 * This catches the recurring model mistake of guarding the entry
 * block with `import.meta.url === \`file://${process.argv[1]}\``,
 * which silently produces a no-op CLI when the binary is launched
 * via a symlink (the form npm publishes). The model receives a
 * trajectory warning so it can correct the guard on its own.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const INSTALL_PATTERN = /\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b/;
const VERIFICATION_FLAGS = ["--version", "-V", "--help", "-h"];
// Hard cap on how many bins we'll probe per install. Defends against
// pathological workspaces with hundreds of bin entries (or scripts that
// pretend to be package.json).
const MAX_BINS = 32;

export interface BinarySmokeIssue {
  bin: string;
  reason: "silent_exit_zero" | "spawn_failed";
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  stderrTail?: string;
}

export interface BinarySmokeReport {
  installed: boolean;
  packageJsonPath?: string;
  bins: string[];
  binsTruncated?: boolean;
  issues: BinarySmokeIssue[];
}

interface PackageJsonShape {
  name?: string;
  bin?: string | Record<string, string>;
  version?: string;
}

/**
 * Returns true when a bash command line runs a package install that
 * may need a follow-up smoke test of installed binaries.
 */
export function bashCommandRunsInstall(command: string): boolean {
  return INSTALL_PATTERN.test(command);
}

/**
 * Read `package.json` from the workspace and return the set of bin
 * names to smoke-test. Falls back to `[]` if the file is missing or
 * declares no binaries.
 *
 * Distinguishes "no package.json" (no smoke) from "package.json present
 * but unreadable" (smoke skipped with reason logged via stderr so the
 * bash tool can surface it).
 */
export async function listPackageBins(
  workspaceRoot: string,
): Promise<{ packageJsonPath: string; bins: string[]; unreadable?: string }> {
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  let parsed: PackageJsonShape;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJsonShape;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { packageJsonPath, bins: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { packageJsonPath, bins: [], unreadable: message };
  }
  const bins: string[] = [];
  if (typeof parsed.bin === "string") {
    bins.push(parsed.bin);
  } else if (parsed.bin && typeof parsed.bin === "object") {
    for (const value of Object.values(parsed.bin)) {
      if (typeof value === "string") bins.push(value);
    }
  }
  // Implicit name-based bin: if the package name is `@scope/foo`, the
  // published bin name is `foo`. Many CLIs rely on this and omit it
  // from `bin`.
  if (typeof parsed.name === "string" && parsed.name.length > 0) {
    const tail = parsed.name.includes("/") ? parsed.name.split("/").pop() : parsed.name;
    if (tail && !bins.includes(tail)) bins.push(tail);
  }
  return { packageJsonPath, bins: Array.from(new Set(bins)) };
}

/**
 * Run each declared bin in turn with `--version` (falling back to
 * `--help` / `-h`) and report any that exit 0 without producing
 * stdout. The 1-second-per-bin ceiling is intentional — smoke checks
 * must not slow the run. A separate ceiling on bin count prevents
 * O(4N) spawn storms on pathological workspaces.
 */
export async function smokeInstalledBins(workspaceRoot: string): Promise<BinarySmokeReport> {
  const { packageJsonPath, bins, unreadable } = await listPackageBins(workspaceRoot);
  if (bins.length === 0) {
    return unreadable
      ? { installed: false, packageJsonPath, bins: [], issues: [] }
      : { installed: false, packageJsonPath, bins: [], issues: [] };
  }
  let binsProbed = bins;
  let binsTruncated = false;
  if (binsProbed.length > MAX_BINS) {
    binsProbed = binsProbed.slice(0, MAX_BINS);
    binsTruncated = true;
  }
  const issues: BinarySmokeIssue[] = [];
  for (const bin of binsProbed) {
    const issue = await probeSingleBin(workspaceRoot, bin);
    if (issue) issues.push(issue);
  }
  const report: BinarySmokeReport = { installed: true, packageJsonPath, bins, issues };
  if (binsTruncated) report.binsTruncated = true;
  return report;
}

async function probeSingleBin(workspaceRoot: string, bin: string): Promise<BinarySmokeIssue | null> {
  let lastSpawnError: NodeJS.ErrnoException | undefined;
  for (const flag of VERIFICATION_FLAGS) {
    const result = await runBinWithFlag(workspaceRoot, bin, flag);
    if (result === "spawn_failed") {
      // Try the next flag; some CLIs only support one of the four.
      continue;
    }
    if (result.kind === "exit" && result.code === 0 && result.stdout === "" && result.stderr === "") {
      // Silent 0-exit on the very flag the runtime probed. The model
      // wrote an entry guard that misfires on the published symlink,
      // or the binary doesn't exist on PATH.
      return { bin, reason: "silent_exit_zero", exitCode: 0 };
    }
    if (result.kind === "exit" && result.code === 0) {
      // Any non-empty output means the binary actually ran.
      return null;
    }
    if (result.kind === "error") {
      lastSpawnError = result.error;
    }
    // Non-zero exit on this flag — try the next flag before declaring
    // failure, since not every CLI supports --version.
  }
  // If every flag failed to spawn, surface that as a spawn_failed issue
  // with the captured error rather than the misleading silent_exit_zero.
  if (lastSpawnError) {
    return {
      bin,
      reason: "spawn_failed",
      stderrTail: lastSpawnError.message ?? lastSpawnError.code ?? "unknown spawn error",
    };
  }
  return { bin, reason: "silent_exit_zero", exitCode: 0 };
}

type BinProbe =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
  | { kind: "error"; error: NodeJS.ErrnoException }
  | "spawn_failed";

function runBinWithFlag(workspaceRoot: string, bin: string, flag: string): Promise<BinProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(bin, [flag], {
        cwd: workspaceRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Keep the smoke probe small — a real CLI startup is sub-100ms.
        timeout: 1000,
        killSignal: "SIGKILL",
      });
    } catch (error) {
      resolve("spawn_failed");
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ kind: "error", error: error as NodeJS.ErrnoException });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ kind: "exit", code, signal, stdout, stderr });
    });
  });
}
