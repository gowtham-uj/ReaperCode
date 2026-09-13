import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';

export interface EnvironmentFingerprint {
  os: string;
  arch: string;
  nodeVersion: string;
  npmVersion: string;
  glibcVersion: string | null;
  availableTools: string[];
  dockerCliAvailable: boolean;
  dockerDaemonAvailable: boolean;
  dockerStatus: "available" | "cli_missing" | "daemon_unavailable";
  cwd: string;
}

const TOOLS_TO_CHECK = [
  'git', 'docker', 'docker-compose', 'python3', 'pip3', 'make', 'gcc', 'g++', 'sqlite3', 'curl', 'wget',
  'pg_isready', 'psql', 'mysql', 'mongosh', 'redis-cli', 'prisma', 'tsx', 'ts-node', 'next', 'vite', 'vi', 'nano', 'grep', 'find', 'sed', 'awk', 'jq',
];

/**
 * Per-process cache so a long-running TUI doesn't re-shell-out to
 * `command -v` 27 times on every prompt. Keyed by cwd so different
 * workspaces in the same process get fresh results.
 */
const fingerprintCache = new Map<string, EnvironmentFingerprint>();

/** Test seam: the cache is keyed by cwd, and tests reuse temp directories. */
export function _resetFingerprintCacheForTests(): void {
  fingerprintCache.clear();
}

/**
 * Which of `TOOLS_TO_CHECK` resolve on PATH, in one shell invocation.
 *
 * This used to be one `execFile('command', ['-v', tool])` per tool, and it
 * never worked: `command` is a shell builtin, not an executable, so every
 * spawn failed with ENOENT and the fingerprint reported an empty tool list on
 * every machine. It also cost about 500ms — 27 process spawns, concurrent but
 * still dominated by fork/exec — on the path between "user presses Enter" and
 * "first token", which is most of that budget.
 *
 * One `sh -c` fixes both: the builtin behaves as documented, and 27 spawns
 * become one. The tool names are a hardcoded constant and are passed as
 * positional arguments rather than interpolated into the script, so nothing
 * here can turn into shell injection if that list ever becomes dynamic.
 */
async function discoverAvailableTools(): Promise<string[]> {
  const script =
    'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && printf "%s\\n" "$t"; done';
  try {
    const stdout = await execFileAsync('sh', ['-c', script, 'sh', ...TOOLS_TO_CHECK]);
    const found = new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    // Preserve TOOLS_TO_CHECK order so the fingerprint is stable across runs.
    return TOOLS_TO_CHECK.filter((tool) => found.has(tool));
  } catch {
    return [];
  }
}

/**
 * Async + cached variant of the legacy synchronous fingerprint
 * function. The legacy version did 27+ sequential `execSync` calls
 * (`command -v <tool>` for each entry in `TOOLS_TO_CHECK`) on the
 * event loop, blocking the TUI for hundreds of ms before the model
 * call could even start. This version runs them concurrently via
 * `Promise.all` and caches the result per cwd.
 *
 * Callers MUST `await` — this changes the signature from sync to
 * async. The TUI is already async; legacy callers in
 * `computeContentPrep` already `await` upstream so the change is
 * transparent.
 */
export async function getEnvironmentFingerprint(cwd: string): Promise<EnvironmentFingerprint> {
  const cached = fingerprintCache.get(cwd);
  if (cached) return cached;

  const availableTools = await discoverAvailableTools();

  let glibcVersion: string | null = null;
  if (process.platform === 'linux') {
    try {
      const output = await execFileAsync('ldd', ['--version']);
      const match = output.match(/(?:glibc|GNU libc) ([\d.]+)/i);
      glibcVersion = match ? match[1] ?? null : null;
    } catch {
      glibcVersion = null;
    }
  }

  let npmVersion = 'unknown';
  try {
    npmVersion = (await execFileAsync('npm', ['-v'])).trim();
  } catch {
    npmVersion = 'unknown';
  }

  const dockerCliAvailable = availableTools.includes('docker');
  const dockerDaemonAvailable = dockerCliAvailable ? await canUseDockerDaemon(cwd) : false;

  const result: EnvironmentFingerprint = {
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    nodeVersion: process.version,
    npmVersion,
    glibcVersion,
    availableTools,
    dockerCliAvailable,
    dockerDaemonAvailable,
    dockerStatus: dockerDaemonAvailable ? 'available' : dockerCliAvailable ? 'daemon_unavailable' : 'cli_missing',
    cwd,
  };
  fingerprintCache.set(cwd, result);
  return result;
}

/** Synchronous fallback for callers that genuinely cannot be async. */
export function getEnvironmentFingerprintSync(cwd: string): EnvironmentFingerprint {
  const cached = fingerprintCache.get(cwd);
  if (cached) return cached;

  /*
   * This function had two independent faults, both silent.
   *
   * It reached for `child_process` through `require`, which does not exist in
   * an ES module, so it threw `require is not defined` before running a single
   * probe. And its probes were `execFileSync('command', ...)` — a shell
   * builtin with no executable — so even with a working `require` they would
   * have failed ENOENT. Both faults landed in a `catch` that returned an empty
   * list, and an empty tool list reads as a legitimate answer about the
   * machine rather than as a broken probe.
   *
   * The fix is the same as the async variant's: a static import, and one
   * shell invocation instead of one per tool.
   */
  let availableTools: string[] = [];
  try {
    const out = execFileSync(
      'sh',
      ['-c', 'for t in "$@"; do command -v "$t" >/dev/null 2>&1 && printf "%s\\n" "$t"; done', 'sh', ...TOOLS_TO_CHECK],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString();
    const found = new Set(out.split('\n').map((line) => line.trim()).filter(Boolean));
    availableTools = TOOLS_TO_CHECK.filter((tool) => found.has(tool));
  } catch {
    availableTools = [];
  }

  let glibcVersion: string | null = null;
  if (process.platform === 'linux') {
    try {
      const out = execFileSync('ldd', ['--version']).toString();
      const m = out.match(/(?:glibc|GNU libc) ([\d.]+)/i);
      glibcVersion = m ? m[1] ?? null : null;
    } catch {
      glibcVersion = null;
    }
  }

  let npmVersion = 'unknown';
  try {
    npmVersion = execFileSync('npm', ['-v']).toString().trim();
  } catch {
    npmVersion = 'unknown';
  }

  const dockerCliAvailable = availableTools.includes('docker');
  const dockerDaemonAvailable = dockerCliAvailable ? canUseDockerDaemonSync(cwd) : false;

  const result: EnvironmentFingerprint = {
    os: `${process.platform} ${os.release()}`,
    arch: process.arch,
    nodeVersion: process.version,
    npmVersion,
    glibcVersion,
    availableTools,
    dockerCliAvailable,
    dockerDaemonAvailable,
    dockerStatus: dockerDaemonAvailable ? 'available' : dockerCliAvailable ? 'daemon_unavailable' : 'cli_missing',
    cwd,
  };
  fingerprintCache.set(cwd, result);
  return result;
}

export function renderFingerprintForPrompt(fp: EnvironmentFingerprint): string {
  return `ENVIRONMENT FINGERPRINT:
- OS: ${fp.os}
- Arch: ${fp.arch}
- Node: ${fp.nodeVersion}
- npm: ${fp.npmVersion}
- libc: ${fp.glibcVersion ?? 'non-glibc or unknown'}
- CWD: ${fp.cwd}
- Docker: ${fp.dockerStatus}
- Tools: ${fp.availableTools.join(', ')}
CRITICAL: Use this information to choose compatible libraries. For example, if libc is < 2.38, avoid native libraries that require newer glibc.
CRITICAL: The task workspace root is ${fp.cwd}. Do not cd to the host repository root or install dependencies there. Use relative paths from this workspace or $WORKSPACE.
CRITICAL: If Docker is cli_missing or daemon_unavailable, do not run docker, docker compose, or docker-compose. You may still create/read Docker files and validate them by static inspection.`;
}

function execFileAsync(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2_000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function canUseDockerDaemon(cwd: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('docker', ['info'], { cwd, timeout: 5_000 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

function canUseDockerDaemonSync(cwd: string): boolean {
  try {
    execFileSync('docker', ['info'], { cwd, stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}