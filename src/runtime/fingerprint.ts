import { execFile } from 'node:child_process';
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

  const availableToolsResults = await Promise.all(
    TOOLS_TO_CHECK.map(async (tool) => {
      try {
        await execFileAsync('command', ['-v', tool]);
        return tool;
      } catch {
        return null;
      }
    }),
  );
  const availableTools = availableToolsResults.filter((t): t is string => t !== null);

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

  const availableTools: string[] = [];
  for (const tool of TOOLS_TO_CHECK) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:child_process').execFileSync('command', ['-v', tool], { stdio: 'ignore' });
      availableTools.push(tool);
    } catch {
      // Tool not available
    }
  }

  let glibcVersion: string | null = null;
  if (process.platform === 'linux') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const out = require('node:child_process').execFileSync('ldd', ['--version']).toString();
      const m = out.match(/(?:glibc|GNU libc) ([\d.]+)/i);
      glibcVersion = m ? m[1] ?? null : null;
    } catch {
      glibcVersion = null;
    }
  }

  let npmVersion = 'unknown';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    npmVersion = require('node:child_process').execFileSync('npm', ['-v']).toString().trim();
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:child_process').execFileSync('docker', ['info'], { cwd, stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}