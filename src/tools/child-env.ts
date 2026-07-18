/**
 * tools/child-env.ts — Workflow 3 unified child environment builder.
 *
 * Single source of truth for the environment that every Reaper-spawned
 * child process receives (foreground bash, background bash, JavaScript
 * eval, Python eval, and any shellRunner-compatible child). Without
 * this module, secrets like provider keys, GitHub tokens, AWS creds,
 * database URLs, and cookies silently leak to any command the model
 * runs — a defense-in-depth failure.
 *
 * Design contract:
 *
 *   1. Benign variables required for normal execution (PATH, HOME,
 *      shell/runtime locale, project virtualenv indicators, user-defined
 *      harmless variables, the existing Reaper scratchpad pointers) are
 *      preserved.
 *
 *   2. Sensitive variables are stripped by default using an explicit
 *      sensitive-name set + credential-bearing URL inspection. We do
 *      NOT strip harmless names that merely contain broad substrings
 *      like `KEYBOARD`, `MONKEY`, `PASSWORDLESS`, or `PUBLIC_KEY` —
 *      the classifier uses concrete patterns, not substring matches.
 *
 *   3. The config allowlist is by exact variable name, normalized
 *      consistently (case-insensitive on Windows, case-sensitive on
 *      POSIX). The default is empty; rare commands that intentionally
 *      need a sensitive variable can opt in via `security.childEnvAllowlist`.
 *
 *   4. Diagnostics NEVER print values. Only variable names + counts.
 *
 *   5. The existing `NODE_TEST_CONTEXT` and `NODE_PATH` stripping
 *      behavior is preserved and routed through this builder so the
 *      two code paths cannot drift.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

// ---------------------------------------------------------------------------
// Sensitive name patterns — explicit, conservative, well-named.
// ---------------------------------------------------------------------------

/**
 * Sensitive provider/credential names. The matcher is case-sensitive
 * on POSIX and case-insensitive on Windows. The set is intentionally
 * explicit (not substring-based) so that harmless names like
 * `KEYBOARD_LAYOUT`, `MONKEY_BUSINESS`, `PASSWORDLESS_AUTH`, or
 * `PUBLIC_KEY_FILE` are NOT stripped.
 *
 * The match is whole-segment: a variable must equal the pattern or be
 * prefixed with the pattern followed by `__` / `_` (to catch
 * `AWS_ACCESS_KEY_ID` from `AWS_ACCESS_KEY`).
 */
const SENSITIVE_EXACT: ReadonlySet<string> = new Set<string>([
  // Anthropic / Claude
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // OpenAI / Codex
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_CODEX_ACCESS_TOKEN",
  "OPENAI_CODEX_REFRESH_TOKEN",
  "OPENAI_PROJECT",
  // Google / Gemini
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_KEYFILE_JSON",
  "GCLOUD_SERVICE_KEY",
  // DeepSeek / Cerebras / OpenRouter / MiniMax / LiteLLM
  "DEEPSEEK_API_KEY",
  "CEREBRAS_API_KEY",
  "OPENROUTER_API_KEY",
  "LITELLM_API_KEY",
  "LITELLM_MASTER_KEY",
  "LITELLM_SALT_KEY",
  // VCS tokens
  "GITHUB_TOKEN",
  "GITHUB_PAT",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "GITLAB_PRIVATE_TOKEN",
  "BITBUCKET_TOKEN",
  "BITBUCKET_USERNAME",
  "BITBUCKET_PASSWORD",
  "AZURE_DEVOPS_TOKEN",
  // Cloud providers
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_REGION",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "GCP_SERVICE_ACCOUNT_KEY",
  "GCP_PROJECT_ID",
  "GCP_SA_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "DIGITALOCEAN_TOKEN",
  "DO_API_TOKEN",
  "HEROKU_API_KEY",
  "VERCEL_TOKEN",
  "NETLIFY_AUTH_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  // Package registries
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NODE_AUTH_TOKEN",
  "PNPM_AUTH_TOKEN",
  "YARN_AUTH_TOKEN",
  "PYPI_TOKEN",
  "TWINE_PASSWORD",
  "TWINE_USERNAME",
  "DOCKERHUB_TOKEN",
  "DOCKER_TOKEN",
  "REGISTRY_TOKEN",
  "GHCR_TOKEN",
  // Databases / caches / brokers
  "DATABASE_URL",
  "DATABASE_PASSWORD",
  "DB_PASSWORD",
  "DB_URL",
  "MONGO_URL",
  "MONGO_URI",
  "MONGODB_URI",
  "MONGODB_PASSWORD",
  "REDIS_URL",
  "REDIS_PASSWORD",
  "REDIS_TOKEN",
  "POSTGRES_URL",
  "POSTGRES_PASSWORD",
  "POSTGRESQL_PASSWORD",
  "MYSQL_URL",
  "MYSQL_PASSWORD",
  "CASSANDRA_PASSWORD",
  "ELASTIC_PASSWORD",
  "RABBITMQ_URL",
  "RABBITMQ_PASSWORD",
  "KAFKA_BROKER_PASSWORD",
  "MEMCACHED_PASSWORD",
  // Auth / session / cookies / bearer
  "AUTH_TOKEN",
  "AUTH_SECRET",
  "SESSION_SECRET",
  "SESSION_TOKEN",
  "SESSION_ID",
  "SESSION_COOKIE",
  "JWT_SECRET",
  "JWT_TOKEN",
  "BEARER_TOKEN",
  "API_TOKEN",
  "API_KEY",
  "API_SECRET",
  "SECRET_KEY",
  "PRIVATE_KEY",
  "PRIVATE_KEY_PATH",
  "CLIENT_SECRET",
  "CLIENT_KEY",
  "COOKIE_SECRET",
  "COOKIE",
  "AUTH_COOKIE",
  "SESS_COOKIE",
  "PHPSESSID",
  "CSRF_TOKEN",
  "XSRF_TOKEN",
  "OAUTH_TOKEN",
  "OAUTH_SECRET",
  "OAUTH_CLIENT_SECRET",
  "REFRESH_TOKEN",
  "ID_TOKEN",
  "ACCESS_TOKEN",
  // Generic credentials / passwords / passphrases
  "PASSWORD",
  "PASSWD",
  "PASS",
  "PASSPHRASE",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
  "MASTER_KEY",
  "ROOT_PASSWORD",
  "ADMIN_PASSWORD",
  "DB_PASS",
  "DB_SECRET",
  "SSH_AUTH_SOCK", // SSH agent socket — sensitive path.
  "SSH_AGENT_PID",
  // Vault / secret stores
  "VAULT_TOKEN",
  "VAULT_ADDR",
  "VAULT_CLIENT_KEY",
  "VAULT_CLIENT_CERT",
  "CONSUL_HTTP_TOKEN",
  "NOMAD_TOKEN",
  // Connection strings (handled by URL inspection too, but a common naming)
  "CONNECTION_STRING",
  "CONN_STRING",
  "DSN",
  "DATABASE_DSN",
  "PG_DSN",
  // Misc providers seen in the wild
  "REPLICATE_API_TOKEN",
  "HUGGINGFACE_TOKEN",
  "HF_TOKEN",
  "PINECONE_API_KEY",
  "SUPABASE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "TWILIO_AUTH_TOKEN",
  "SENDGRID_API_KEY",
  "SLACK_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_WEBHOOK_URL",
  "DISCORD_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_ACTIONS_TOKEN",
  // Pi / opencode internal providers that the build scripts set
  "PI_API_KEY",
  "MINIMAX_API_KEY",
  "NURALWATT_API_KEY",
  "NURALWATT_API_KEY2",
  "SERPER_SEARCH_API_KEY",
  "MIMO_SEARCH_API_KEY",
]);

/**
 * Sensitive variable PREFIXES. A variable name is stripped if it
 * begins with one of these prefixes (followed by `_` or `__` to avoid
 * matching the prefix-as-a-whole-word accidentally). Prefixes are
 * case-sensitive on POSIX and case-insensitive on Windows.
 */
const SENSITIVE_PREFIXES: ReadonlyArray<string> = [
  // Provider / service URL roots that often embed keys
  "OPENAI_API",
  "ANTHROPIC_API",
  "GOOGLE_API",
  "GEMINI_API",
  "DEEPSEEK_API",
  "CEREBRAS_API",
  "OPENROUTER_API",
  "LITELLM_API",
  "MINIMAX_API",
  "NURALWATT_API",
  // Auth-prefixed tokens
  "AUTH_",
  "OAUTH_",
  "JWT_",
  "SESSION_",
  "COOKIE_",
  "BEARER_",
  "API_",
  // Generic credentials
  "SECRET_",
  "PASS_",
  "PASSWORD_",
  "PASSWD_",
  "PRIVATE_",
  "TOKEN_",
  "CREDENTIAL_",
];

/**
 * Names that look sensitive but are actually benign and should NEVER
 * be stripped. The classifier consults this allowlist before stripping
 * a name based on prefix or URL inspection.
 */
const SENSITIVE_LOOKALIKE_EXACT: ReadonlySet<string> = new Set<string>([
  "PATH",
  "PATHEXT",
  "PATH_SEPARATOR",
  "PUBLIC_KEY",
  "PUBLIC_KEY_FILE",
  "PASSWORDLESS_AUTH",
  "PASSWORDLESS_LOGIN",
  "KEYBOARD_LAYOUT",
  "KEYBOARD_REPEAT",
  "KEYBOARD_TYPE",
  "MONKEY_BUSINESS",
  "MONKEY_TEST",
  "ACCESSIBILITY_ENABLED",
  "ACCESS_MODE",
  "PASSTHROUGH",
  "PASSPHRASE_PROMPT",
  "TOKENIZER_VERSION",
  "SECRETS_DIR",
  "SECRETS_PATH",
  "TOKEN_TYPE",
  "TOKEN_NAME",
  "KEY_FILE",
  "KEY_NAME",
]);

/**
 * Variable names that should NEVER be passed through to children,
 * regardless of value or allowlist, because they control Node /
 * process behavior and have been historically abused for code injection
 * or sub-shell control.
 */
const ALWAYS_DROP_EXACT: ReadonlySet<string> = new Set<string>([
  "NODE_TEST_CONTEXT", // preserves the historical explicit drop
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_NO_WARNINGS",
  "NODE_NO_HTTP2",
  "NODE_V8_COVERAGE",
  "NODE_PENDING_PIPE_INSTANCES",
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_OPTIONS_HISTORY",
  "NODE_ENV_DEVELOPMENT",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONINSPECT",
  "PYTHONBREAKPOINT",
  "BASH_ENV",
  "ENV",
  "BASH_FUNC_",
  "SHELLOPTS",
  "GLOBIGNORE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "IFS",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChildEnvBuildOptions {
  /** Workspace root used to derive REAPER_* scratchpad variables. */
  workspaceRoot: string;
  /**
   * Optional explicit allowlist of variable names to keep even if the
   * classifier would otherwise strip them. Defaults to `[]`. Entries
   * are matched case-insensitively on Windows and case-sensitively on
   * POSIX, then stored normalized.
   */
  allowlist?: ReadonlyArray<string>;
  /**
   * Source environment. Defaults to `process.env` (the current
   * Node process environment). Override in tests with a fixture.
   */
  sourceEnv?: NodeJS.ProcessEnv;
  /**
   * Set to true to log a structured diagnostic record describing
   * which variables were stripped and which were preserved. NEVER logs
   * values — only names and counts.
   */
  diagnostics?: boolean;
}

export interface ChildEnvBuildResult {
  /** Final env handed to `spawn()` / `execFile()`. */
  env: NodeJS.ProcessEnv;
  /** Names of variables that were stripped (no values). */
  stripped: ReadonlyArray<string>;
  /** Names of variables that were kept via the allowlist (no values). */
  allowlisted: ReadonlyArray<string>;
  /** Number of variables present in the source env. */
  sourceCount: number;
  /** Number of variables present in the final env. */
  finalCount: number;
}

// ---------------------------------------------------------------------------
// URL inspection — credential-bearing URLs always strip
// ---------------------------------------------------------------------------

const URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/)([^\/\s@]+)@/i;

/**
 * True when the value looks like a connection string / DSN / URL that
 * contains embedded credentials (e.g. `postgres://user:pass@host`,
 * `mongodb://admin:secret@db.example.com`, `redis://default:token@...`).
 */
function valueContainsEmbeddedCredentials(value: string): boolean {
  if (!value) return false;
  // First check: does it match a credential-bearing URL pattern?
  if (URL_PATTERN.test(value)) return true;
  // Common connection-string schemes that may not use //user:pass@
  if (/^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps|mariadb|sqlserver|mssql|clickhouse|elastic|elasticsearch|cassandra):/i.test(value)) {
    // Look for username:password@host or similar
    if (/[a-z0-9._-]+:[^\s@]+@[a-z0-9.-]+/i.test(value)) return true;
    // mysql://user@host is fine; we only care about credentialed DSNs
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sensitive-name classifier
// ---------------------------------------------------------------------------

/**
 * Returns true if the given variable name (as it appears in the env
 * object) should be stripped by default. Considers exact matches,
 * conservative prefix matches, and the lookalike-allowlist.
 *
 * The match is always case-insensitive — POSIX env names are
 * conventionally uppercase but tools sometimes set them lowercased
 * (`anthropic_api_key`, `openai_api_key`), and without
 * case-insensitive matching the stripper would silently let those
 * through. Windows hosts use case-insensitive comparisons natively;
 * we apply the same rule everywhere so the behavior is consistent.
 * Benign lookalikes (`PATH`, `PUBLIC_KEY`, `KEYBOARD_LAYOUT`,
 * `PASSWORDLESS_AUTH`, ...) are compared in the same case-insensitive
 * fashion so they continue to win.
 */
export function isSensitiveEnvName(name: string, allowlist: ReadonlySet<string>): boolean {
  if (!name) return false;
  const normalized = name.toUpperCase();

  // Allowlist always wins. Compare case-insensitively everywhere so a
  // workspace opt-in via `childEnvAllowlist: ["my_token"]` matches even
  // if the env actually contains `MY_TOKEN`.
  for (const allowed of allowlist) {
    if (allowed.toUpperCase() === normalized) return false;
  }

  // Never drop lookalikes.
  for (const lookalike of SENSITIVE_LOOKALIKE_EXACT) {
    if (lookalike.toUpperCase() === normalized) return false;
  }

  // Always-drop list.
  for (const alwaysDrop of ALWAYS_DROP_EXACT) {
    if (alwaysDrop.toUpperCase() === normalized) return true;
  }

  // Explicit exact matches.
  for (const sensitive of SENSITIVE_EXACT) {
    if (sensitive.toUpperCase() === normalized) return true;
  }

  // Prefix matches.
  for (const prefix of SENSITIVE_PREFIXES) {
    const prefixUpper = prefix.toUpperCase();
    if (normalized.startsWith(prefixUpper)) {
      // Confirm it's actually a prefix-extension (not the prefix as a whole).
      if (normalized.length > prefixUpper.length) {
        const boundary = normalized.charAt(prefixUpper.length);
        if (boundary === "_") return true;
      }
    }
  }

  return false;
}

/**
 * Normalize an allowlist entry to the canonical comparison form used by
 * `isSensitiveEnvName`. Always uppercased so a single allowlist entry
 * matches both `my_token` and `MY_TOKEN` in the source environment.
 */
function normalizeAllowlist(entries: ReadonlyArray<string> | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  if (!entries) return out;
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out.add(trimmed.toUpperCase());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Child environment builder
// ---------------------------------------------------------------------------

/**
 * Build a sanitized environment for a Reaper-spawned child. Strips
 * sensitive variables, drops the always-drop set, routes the existing
 * scratchpad env-var contract through here, and merges any caller-
 * supplied allowlist. Returns both the final env and a diagnostic
 * summary (names + counts only).
 */
export function buildChildEnv(options: ChildEnvBuildOptions): ChildEnvBuildResult {
  const sourceEnv = options.sourceEnv ?? process.env;
  const allowlist = normalizeAllowlist(options.allowlist);
  const stripped: string[] = [];
  const allowlisted: string[] = [];

  const env: NodeJS.ProcessEnv = {};
  let sourceCount = 0;
  let finalCount = 0;

  for (const [name, value] of Object.entries(sourceEnv)) {
    if (typeof value === "undefined") continue;
    sourceCount += 1;
    if (isSensitiveEnvName(name, allowlist)) {
      // Check whether the allowlist explicitly kept it (the
      // isSensitiveEnvName function already returned true because
      // it was sensitive, so we need to detect allowlist membership
      // separately). Compare case-insensitively everywhere so a
      // `childEnvAllowlist: ["MY_TOKEN"]` entry preserves both
      // `MY_TOKEN` and `my_token` source entries.
      let allowlistedThis = false;
      const normalizedName = name.toUpperCase();
      for (const allowed of allowlist) {
        if (allowed.toUpperCase() === normalizedName) {
          allowlistedThis = true;
          break;
        }
      }
      // If isSensitiveEnvName returned false we'd have taken the keep
      // branch instead. So this branch is only reached when the
      // variable IS sensitive. The only way to keep it is the
      // allowlist membership check above.
      if (allowlistedThis) {
        env[name] = value;
        allowlisted.push(name);
        finalCount += 1;
        continue;
      }
      stripped.push(name);
      continue;
    }
    // Insensitive name: also inspect the value for embedded credentials.
    if (typeof value === "string" && valueContainsEmbeddedCredentials(value)) {
      // Only strip credential-bearing URLs whose variable name itself
      // looks credential-like. We don't want to drop something like
      // `EXAMPLE_HOMEPAGE=https://user:pass@example.com` set by a test
      // scaffolding script.
      if (/^.*(?:URL|URI|DSN|STRING|PASSWORD|SECRET|TOKEN|CRED|KEY|AUTH|DB_|DATABASE_)/i.test(name)) {
        stripped.push(name);
        continue;
      }
    }
    env[name] = value;
    finalCount += 1;
  }

  // Apply Reaper scratchpad env contract (always set, even if not in
  // the source env). These mirror the historical buildCommandEnv
  // contract so existing tests keep passing.
  const scratchpad = getReaperScratchpadPaths(options.workspaceRoot);
  env.REAPER_SCRATCHPAD = toShellPath(scratchpad.root);
  env.REAPER_ARTIFACTS_DIR = toShellPath(scratchpad.artifacts);
  env.REAPER_DEPENDENCIES_DIR = toShellPath(scratchpad.dependencies);
  env.REAPER_CACHE_DIR = toShellPath(scratchpad.cache);
  env.WORKSPACE = toShellPath(options.workspaceRoot);
  env.NPM_CONFIG_CACHE = toShellPath(path.join(scratchpad.cache, "npm"));
  env.PNPM_HOME = toShellPath(path.join(scratchpad.dependencies, "pnpm-home"));
  env.PNPM_STORE_PATH = toShellPath(path.join(scratchpad.cache, "pnpm-store"));
  env.YARN_CACHE_FOLDER = toShellPath(path.join(scratchpad.cache, "yarn"));
  env.PIP_CACHE_DIR = toShellPath(path.join(scratchpad.cache, "pip"));
  if (!env.CARGO_HOME) env.CARGO_HOME = toShellPath(path.join(scratchpad.dependencies, "cargo"));
  if (!env.GOMODCACHE) env.GOMODCACHE = toShellPath(path.join(scratchpad.cache, "go-mod"));
  if (!env.GOCACHE) env.GOCACHE = toShellPath(path.join(scratchpad.cache, "go-build"));

  // PATH enrichment: ensure baseline system paths + workspace virtualenv
  // when present.
  env.PATH = ensureSystemPath(filterHostDependencyBins(env.PATH, options.workspaceRoot));
  const venvBin = path.join(options.workspaceRoot, ".venv", "bin");
  if (existsSync(venvBin)) {
    env.PATH = `${venvBin}${path.delimiter}${env.PATH ?? ""}`;
    env.VIRTUAL_ENV = path.join(options.workspaceRoot, ".venv");
  }
  const evalToolchainBin = sourceEnv.REAPER_EVAL_TOOLCHAIN_BIN;
  if (
    evalToolchainBin &&
    typeof evalToolchainBin === "string" &&
    existsSync(evalToolchainBin) &&
    !(env.PATH ?? "").split(path.delimiter).includes(evalToolchainBin)
  ) {
    env.PATH = `${evalToolchainBin}${path.delimiter}${env.PATH ?? ""}`;
  }

  // Mark Node test context as stripped explicitly so existing tests
  // that look for `process.env.NODE_TEST_CONTEXT === undefined`
  // continue to pass.
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_PATH;

  if (options.diagnostics) {
    // Diagnostic line intentionally omits values.
    process.stderr.write(
      `[child-env] built env: source=${sourceCount} final=${finalCount} stripped=${stripped.length} allowlisted=${allowlisted.length} random=${randomUUID()}\n`,
    );
  }

  return { env, stripped, allowlisted, sourceCount, finalCount };
}

function toShellPath(value: string): string {
  return process.platform === "win32" ? value.replace(/\\/g, "/") : value;
}

function ensureSystemPath(currentPath: string | undefined): string {
  const required = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
  const entries = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of required) {
    if (existsSync(entry) && !entries.includes(entry)) {
      entries.push(entry);
    }
  }
  return entries.join(path.delimiter);
}

function filterHostDependencyBins(currentPath: string | undefined, workspaceRoot: string): string {
  const entries = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  const resolvedWorkspace = path.resolve(workspaceRoot);
  return entries
    .filter((entry) => {
      const resolved = path.resolve(entry);
      if (!resolved.includes(`${path.sep}node_modules${path.sep}.bin`)) return true;
      return resolved === path.join(resolvedWorkspace, "node_modules", ".bin") || resolved.startsWith(`${resolvedWorkspace}${path.sep}`);
    })
    .join(path.delimiter);
}

// ---------------------------------------------------------------------------
// Public convenience re-exports
// ---------------------------------------------------------------------------

export const ChildEnv = {
  build: buildChildEnv,
  isSensitiveName: isSensitiveEnvName,
};