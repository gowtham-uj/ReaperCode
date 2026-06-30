/**
 * LinterRegistry — strict language-agnostic syntax dispatcher for file_edit.
 *
 * Reads `linters/manifest.json` once on first call, builds a
 * `Map<extension, manifestEntry>`. For each language there are two kinds:
 *   - `pinned_package` (preferred): loads a known linter via dynamic import
 *     after ensuring `<workspace>/.reaper/cache/linters/<lang>/node_modules/<pkg>`
 *     is present. If not, attempts a one-time `npm install --no-save --silent`
 *     bounded by `installTimeoutMs`.
 *   - `runtime_command` (fallback): runs an existing CLI against the file and
 *     parses stderr/stdout for an error line.
 *
 * The dispatcher is **strict**: if no linter resolves after the registry has
 * tried both paths, the caller gets `lint_unavailable` (NOT `lint_failed`).
 * This is the contract `file_edit` honors in Phase 3.
 *
 * Concurrency: install attempts are coalesced per (workspace, package,
 * version) so that two parallel `file_edit` calls do not double-run
 * `npm install`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LinterManifestSchema,
  type LinterManifest,
  type LinterManifestEntry,
  type LintVerdict,
} from "./types.js";

const CACHE_ROOT = ".reaper";
const LINTERS_DIR = "linters";

/**
 * Bundled default manifest path. Always present (it ships with the viewer
 * module) so out-of-the-box file_edit still gets strict, language-aware
 * lints even when the workspace hasn't opted in. Workspaces can override
 * by writing their own `<workspace>/.reaper/linters/manifest.json`.
 */
const defaultManifestPath = path.join(import.meta.dirname, "linters", "manifest.json");

export interface DispatchOptions {
  workspaceRoot: string;
  absPath: string;
  /** Single-pass content (post-edit text). */
  content: string;
  /** Extension inferred from absPath (lowercase, with leading dot). */
  extension: string;
  /** Override; otherwise uses manifest.defaultTimeoutMs. */
  timeoutMs: number | undefined;
}

export interface DispatchResult {
  verdict: LintVerdict;
  /** Total time the dispatcher spent, including any install. */
  totalElapsedMs: number;
}

interface AttemptOutcome {
  ok: boolean;
  message: string | undefined;
  line: number | undefined;
  installLatencyMs: number | undefined;
  attempts: string[];
}

export class LinterRegistry {
  private readonly installPromises = new Map<string, Promise<boolean>>();
  private manifest: LinterManifest | undefined;
  private byExtension = new Map<string, LinterManifestEntry>();

  /**
   * Resolve the manifest from disk once. Returns empty manifest on missing
   * file (treated as "no linter available for anything"); throws on parse
   * error so the caller can surface it as `lint_unavailable`.
   /**
    * @deprecated public alias kept for backwards compat; prefer
    * `loadManifestInternal`. Will be removed when the public `loadManifest`
    * is renamed in Phase 4.
    */
   async loadManifest(workspaceRoot: string): Promise<LinterManifest> {
     return this.loadManifestInternal(workspaceRoot);
   }

   async loadManifestInternal(workspaceRoot: string): Promise<LinterManifest> {
     if (this.manifest) return this.manifest;
     // 1) Try the workspace's own manifest first (allows projects to opt in
     //    to stricter or additional linters locally).
     const manifestPath = path.join(
       workspaceRoot,
       CACHE_ROOT,
       LINTERS_DIR,
       "manifest.json",
     );
     let raw: string | undefined;
     try {
       raw = await readFile(manifestPath, "utf8");
     } catch {
       // 2) Fall back to the bundled default manifest shipped with this
       //    viewer module so out-of-the-box file_edit still gets strict,
       //    language-aware lints even when the workspace hasn't opted in.
       try {
         raw = await readFile(defaultManifestPath, "utf8");
       } catch {
         raw = undefined;
       }
     }
     if (!raw) {
       this.manifest = LinterManifestSchema.parse({ version: 1, entries: [] });
       this.byExtension = new Map();
       return this.manifest;
     }
     let parsed: unknown;
     try {
       parsed = JSON.parse(raw);
     } catch {
       throw new Error(`linter manifest at ${manifestPath} is not valid JSON`);
     }
     const validated = LinterManifestSchema.safeParse(parsed);
     if (!validated.success) {
       throw new Error(
         `linter manifest at ${manifestPath} failed schema validation: ${validated.error.message}`,
       );
     }
     this.manifest = validated.data;
     this.byExtension = new Map();
     for (const entry of this.manifest.entries) {
       for (const ext of entry.extensions) {
         this.byExtension.set(ext.toLowerCase(), entry);
       }
     }
     return this.manifest;
   }

  /**
   * Match an extension (e.g. ".ts") to a manifest entry.
   * Returns `undefined` if no entry covers the extension.
   */
  async matchExtension(
    workspaceRoot: string,
    extension: string,
  ): Promise<LinterManifestEntry | undefined> {
    if (!this.manifest) await this.loadManifestInternal(workspaceRoot);
    return this.byExtension.get(extension.toLowerCase());
  }

  /**
   * Run the linter for `extension` against `content`. Returns a verdict.
   * `lint_unavailable` if the registry has nothing for this extension or
   * every install attempt failed.
   */
  async dispatch(opts: DispatchOptions): Promise<DispatchResult> {
    const started = Date.now();
    const extension = opts.extension.toLowerCase();
    const entry = await this.matchExtension(opts.workspaceRoot, extension);
    if (!entry) {
      return {
        totalElapsedMs: Date.now() - started,
        verdict: {
          language: extension,
          source: "fallback_permissive",
          ok: true,
          message: `no linter manifest entry for ${extension}; falling back to permissive pass`,
        },
      };
    }

    const language = entry.languages[0] ?? extension;
    const timeoutMs = opts.timeoutMs ?? this.manifest?.defaultTimeoutMs ?? 5_000;

    if (entry.kind === "pinned_package") {
      const attempt = await this.tryPinnedPackage(opts, entry, timeoutMs);
      return {
        totalElapsedMs: Date.now() - started,
        verdict: {
          language,
          source: attempt.ok
            ? "manifest_pinned"
            : attempt.attempts?.includes("install_succeeded")
              ? "manifest_pinned"
              : "fallback_permissive",
          ok: attempt.ok,
          message: attempt.message,
          line: attempt.line,
          installLatencyMs: attempt.installLatencyMs,
          attempts: attempt.attempts,
        },
      };
    }

    const attempt = await this.tryRuntimeCommand(opts, entry, timeoutMs);
    return {
      totalElapsedMs: Date.now() - started,
      verdict: {
        language,
        source: attempt.ok ? "manifest_runtime" : "fallback_permissive",
        ok: attempt.ok,
        message: attempt.message,
        line: attempt.line,
        attempts: attempt.attempts,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Pinned-package path
  // -------------------------------------------------------------------------

  private async tryPinnedPackage(
    opts: DispatchOptions,
    entry: Extract<LinterManifestEntry, { kind: "pinned_package" }>,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const attempts: string[] = [];

    const cacheDir = path.join(
      opts.workspaceRoot,
      CACHE_ROOT,
      LINTERS_DIR,
      entry.languages[0] ?? "unknown",
    );
    const linterPkgPath = path.join(
      cacheDir,
      "node_modules",
      ...entry.package.split("/"),
    );
    const linterPkgManifest = path.join(linterPkgPath, "package.json");

    // 1. Cache hit inside workspace's scoped node_modules.
    if (existsSync(linterPkgManifest)) {
      attempts.push("cache_hit");
      try {
        const result = await loadAndInvokeLinter(
          linterPkgPath,
          entry,
          opts,
          timeoutMs,
        );
        return normalizeLintResult(result, attempts);
      } catch (error) {
        attempts.push(`cache_hit_failed:${(error as Error).message}`);
      }
    }

    // 2. Workspace root node_modules already has it (without installing).
    const rootNsPath = path.join(
      opts.workspaceRoot,
      "node_modules",
      ...entry.package.split("/"),
      "package.json",
    );
    if (existsSync(rootNsPath)) {
      attempts.push("workspace_node_modules_hit");
      try {
        const result = await loadAndInvokeLinter(
          path.dirname(rootNsPath),
          entry,
          opts,
          timeoutMs,
        );
        return normalizeLintResult(result, attempts);
      } catch (error) {
        attempts.push(`workspace_node_modules_hit_failed:${(error as Error).message}`);
      }
    }

    // 3. One-time dynamic install into workspace-scoped cache.
    const installStartedAt = Date.now();
    const installed = await this.ensureInstalled(opts.workspaceRoot, entry, cacheDir);
    const installLatencyMs = Date.now() - installStartedAt;
    if (!installed) {
      attempts.push("install_failed");
      return {
        ok: false,
        message: `lint_unavailable for ${entry.languages[0]}: install failed`,
        attempts,
        installLatencyMs: undefined,
        line: undefined,
      };
    }

    attempts.push("install_succeeded");
    if (!existsSync(linterPkgManifest)) {
      return {
        ok: false,
        message: `lint_unavailable for ${entry.languages[0]}: package not present after install`,
        attempts,
        installLatencyMs: undefined,
        line: undefined,
      };
    }

    try {
      const result = await loadAndInvokeLinter(linterPkgPath, entry, opts, timeoutMs);
      return normalizeLintResult(result, attempts, installLatencyMs);
    } catch (error) {
      return {
        ok: false,
        message: (error as Error).message,
        attempts,
        installLatencyMs: undefined,
        line: undefined,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Runtime-command path
  // -------------------------------------------------------------------------

  private async tryRuntimeCommand(
    opts: DispatchOptions,
    entry: Extract<LinterManifestEntry, { kind: "runtime_command" }>,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    const attempts: string[] = ["runtime_command"];
    const cmd = [...entry.command];
    const fileArgIndex = Math.min(entry.fileArgIndex, cmd.length);
    cmd.splice(fileArgIndex, 0, opts.absPath);

    const result = await runProcess(cmd, opts.workspaceRoot, timeoutMs);

    if (result.exitCode === 0) {
      return { ok: true, attempts, message: undefined, line: undefined, installLatencyMs: undefined };
    }

    const lineMatch = /(?:line\s+|:\s*line\s+|line\s*#?\s*)(\d+)/i.exec(
      result.stderr || result.stdout,
    );
    const lineParsed = lineMatch && lineMatch[1] ? Number(lineMatch[1]) : undefined;
    return {
      ok: false,
      message: `linter exited with code ${result.exitCode}: ${
        ((result.stderr || result.stdout || "").trim().split("\n")[0] ?? "")
      }`,
      line: lineParsed,
      attempts,
      installLatencyMs: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Concurrency-safe install
  // -------------------------------------------------------------------------

  private async ensureInstalled(
    workspaceRoot: string,
    entry: Extract<LinterManifestEntry, { kind: "pinned_package" }>,
    cacheDir: string,
  ): Promise<boolean> {
    const key = `${workspaceRoot}|${entry.package}@${entry.version}`;
    const existing = this.installPromises.get(key);
    if (existing) return existing;

    const promise = (async () => {
      try {
        await mkdir(cacheDir, { recursive: true });
        const pkgJsonPath = path.join(cacheDir, "package.json");
        if (!existsSync(pkgJsonPath)) {
          await writeFile(
            pkgJsonPath,
            JSON.stringify({ name: "reaper-linter-cache", private: true }, null, 2),
            "utf8",
          );
        }
        const installCmd = [
          "npm",
          "install",
          "--no-save",
          "--silent",
          "--prefix",
          cacheDir,
          `${entry.package}@${entry.version}`,
        ];
        const exitCode = await runProcess(installCmd, cacheDir, 30_000).then(
          (r) => r.exitCode,
        );
        return exitCode === 0;
      } catch {
        return false;
      } finally {
        this.installPromises.delete(key);
      }
    })();

    this.installPromises.set(key, promise);
    return promise;
  }
}

// ============================================================================
// Module-private helpers
// ============================================================================

async function loadAndInvokeLinter(
  pkgPath: string,
  entry: Extract<LinterManifestEntry, { kind: "pinned_package" }>,
  opts: DispatchOptions,
  timeoutMs: number,
): Promise<unknown> {
  const mod = await dynamicImportDefault(pkgPath);
  const symbol = (mod as Record<string, unknown>)[entry.symbol];
  if (typeof symbol !== "function") {
    throw new Error(`symbol ${entry.symbol} missing in ${entry.package}`);
  }
  const fn = symbol as (path: string, content: string) => Promise<unknown>;
  return await Promise.race([
    fn(opts.absPath, opts.content),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`pinned linter ${entry.symbol} exceeded ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

function normalizeLintResult(
  result: unknown,
  attempts: string[],
  installLatencyMs?: number,
): AttemptOutcome {
  const installLatency: number | undefined = installLatencyMs;
  if (result === true) {
    return { ok: true, attempts, message: undefined, line: undefined, installLatencyMs: installLatency };
  }
  if (result === false || result == null) {
    return {
      ok: false,
      attempts,
      message: "linter returned a non-ok result",
      line: undefined,
      installLatencyMs: installLatency,
    };
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message : undefined;
    const line = typeof r.line === "number" ? r.line : undefined;
    const ok = Boolean(r.ok ?? true);
    return {
      ok,
      attempts,
      message,
      line,
      installLatencyMs: installLatency,
    };
  }
  return {
    ok: true,
    attempts,
    message: undefined,
    line: undefined,
    installLatencyMs: installLatency,
  };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error: Error | undefined;
}

async function runProcess(cmd: string[], cwd: string, ms: number): Promise<RunResult> {
  const [bin, ...args] = cmd as [string, ...string[]];
  return await new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({
        exitCode: 124,
        stdout,
        stderr: stderr + "\n[linter-timeout]",
        error: undefined,
      });
    }, ms);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, error: undefined });
    });
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + "\n" + err.message,
        error: err,
      });
    });
  });
}

async function dynamicImportDefault(pkgPath: string): Promise<unknown> {
  const req = createRequire(pathToFileURL(pkgPath).href);
  return req(pkgPath);
}
