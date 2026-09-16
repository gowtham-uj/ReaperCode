/**
 * Unit tests for tools/child-env.ts — Workflow 3 child-process
 * environment sanitization.
 *
 * Coverage targets (see WORKFLOW-3 spec §TESTS):
 *   1. fake secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN,
 *      AWS_SECRET_ACCESS_KEY, DATABASE_URL with embedded credentials,
 *      password/session/cookie variables) are absent in foreground
 *      bash children;
 *   2. the same fake secrets are absent in background bash children
 *      and JavaScript/Python eval children;
 *   3. benign variables remain available;
 *   4. exact allowlisted names are present while other secrets remain
 *      stripped;
 *   5. stripped values never appear in returned output, trajectory, or
 *      audit logs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

import { buildChildEnv, isSensitiveEnvName } from "../../../src/tools/child-env.js";
import { evaluateScript } from "../../../src/tools/eval.js";
import type { CodeToolHost } from "../../../src/tools/code/types.js";
import { createTempWorkspace } from "../../fixtures/workspace.js";

/**
 * A host with no tools.
 *
 * These cases only care that the sandbox itself exposes nothing of the host,
 * so an empty surface is the honest fixture: if a secret could be read here, it
 * would be readable with no tool calls at all.
 */
function emptyCodeHost(): CodeToolHost {
  return {
    names: () => [],
    describe: () => undefined,
    invoke: async () => ({ ok: false, error: { code: "NO_TOOLS", message: "no tools" }, durationMs: 0 }),
  };
}

const FAKE_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-fake-1234567890",
  OPENAI_API_KEY: "sk-openai-fake-0987654321",
  GITHUB_TOKEN: "ghp_fake1234567890abcdef",
  AWS_SECRET_ACCESS_KEY: "aws-secret-fake-AAAA",
  AWS_ACCESS_KEY_ID: "AKIAFAKE00000000",
  DATABASE_URL: "postgres://app:supersecret@db.example.com:5432/app",
  MONGO_URL: "mongodb://admin:mongopassword@mongo.example.com:27017/app",
  REDIS_URL: "redis://:redispassword@redis.example.com:6379",
  JWT_TOKEN: "eyJhbGciOiJIUzI1NiJ9.fake.token",
  SESSION_COOKIE: "session=cookievalue",
  PASSWORD: "plain-password",
  PI_API_KEY: "pi-fake-key",
  MINIMAX_API_KEY: "minimax-fake-key",
  GEMINI_API_KEY: "gemini-fake-key",
};

const BENIGN = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/tmp/fake-home",
  LANG: "en_US.UTF-8",
  WORKSPACE: "/tmp/fake-workspace",
  USER_DEFINED_HARMLESS: "harmless-value",
  PUBLIC_KEY: "ssh-rsa AAAAB3NzaC1yc2EAAAA",
  KEYBOARD_LAYOUT: "us",
};

function buildFakeSourceEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  return {
    ...FAKE_SECRETS,
    ...BENIGN,
    REAPER_SCRATCHPAD: workspaceRoot,
    NODE_TEST_CONTEXT: "should-strip-this",
  };
}

// ---------------------------------------------------------------------------
// Classifier direct unit tests
// ---------------------------------------------------------------------------

test("isSensitiveEnvName catches all expected provider/credential prefixes", () => {
  const samples = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "DATABASE_URL",
    "JWT_TOKEN",
    "SESSION_SECRET",
    "BEARER_TOKEN",
    "PRIVATE_KEY",
    "PI_API_KEY",
    "MINIMAX_API_KEY",
    "AUTH_COOKIE",
    "NODE_OPTIONS",
  ];
  for (const name of samples) {
    assert.equal(isSensitiveEnvName(name, new Set()), true, `${name} should be sensitive`);
  }
});

test("isSensitiveEnvName never strips harmless lookalikes", () => {
  const samples = ["PATH", "PUBLIC_KEY", "KEYBOARD_LAYOUT", "PASSWORDLESS_AUTH", "MONKEY_BUSINESS", "ACCESSIBILITY_ENABLED"];
  for (const name of samples) {
    assert.equal(isSensitiveEnvName(name, new Set()), false, `${name} should NOT be stripped`);
  }
});

/*
 * The prefix rules only match a provider whose name starts with a known root,
 * so a provider named the other way round was passed through intact:
 * `DIGITAL_OCEAN_API_KEY` and `CRAZYROUTER_API_KEY` reached sandboxed children
 * in full while `OPENROUTER_API_KEY` was stripped, purely because of which word
 * came first. A name is the only signal this classifier has, and one ending in
 * `_API_KEY` is a credential whatever precedes it.
 *
 * Written against real names from this workspace's `.env` and its provider
 * catalogue, so the case that leaked is the case under test rather than an
 * invented one.
 */
test("isSensitiveEnvName catches credential-shaped suffixes from any provider", () => {
  const samples = [
    "DIGITAL_OCEAN_API_KEY",
    "CRAZYROUTER_API_KEY",
    "CRAZY_ROUTER_API_KEY",
    "SOME_VENDOR_ACCESS_KEY",
    "MY_APP_CLIENT_SECRET",
    "ACME_API_TOKEN",
    "TEAM_PRIVATE_KEY",
  ];
  for (const name of samples) {
    assert.equal(isSensitiveEnvName(name, new Set()), true, `${name} should be sensitive`);
  }
});

/*
 * The suffix rule must not swallow the lookalikes the exact lists protect.
 * These are the names the suffix list is shaped to avoid: `PUBLIC_KEY` does not
 * end in `_PRIVATE_KEY`, `TOKEN_TYPE` does not end in `_ACCESS_TOKEN`.
 */
test("the suffix rule does not overreach onto lookalikes", () => {
  const samples = [
    "PUBLIC_KEY",
    "TOKEN_TYPE",
    "TOKEN_NAME",
    "KEY_FILE",
    "KEY_NAME",
    "SECRETS_DIR",
    "SECRETS_PATH",
    "TOKENIZER_VERSION",
    "PASSTHROUGH",
  ];
  for (const name of samples) {
    assert.equal(isSensitiveEnvName(name, new Set()), false, `${name} should NOT be stripped`);
  }
});

test("isSensitiveEnvName honors the allowlist", () => {
  // Even though ANTHROPIC_API_KEY is sensitive, an explicit allowlist
  // should let it through.
  assert.equal(isSensitiveEnvName("ANTHROPIC_API_KEY", new Set(["ANTHROPIC_API_KEY"])), false);
  assert.equal(isSensitiveEnvName("ANTHROPIC_API_KEY", new Set()), true);
});

// ---------------------------------------------------------------------------
// buildChildEnv tests
// ---------------------------------------------------------------------------

test("buildChildEnv strips fake secrets and preserves benign vars", () => {
  const workspaceRoot = "/tmp/fake-build-child-env";
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: buildFakeSourceEnv(workspaceRoot),
  });

  // Stripping assertions
  for (const secret of Object.keys(FAKE_SECRETS)) {
    assert.equal(result.env[secret], undefined, `${secret} should be stripped`);
    assert.equal(result.stripped.includes(secret), true, `${secret} should appear in stripped[]`);
  }

  // Benign preservation
  assert.match(result.env.PATH ?? "", /\/bin|\/usr/);
  assert.equal(result.env.HOME, BENIGN.HOME);
  assert.equal(result.env.LANG, BENIGN.LANG);
  assert.equal(result.env.USER_DEFINED_HARMLESS, BENIGN.USER_DEFINED_HARMLESS);

  // The historical NODE_TEST_CONTEXT explicit drop is preserved.
  assert.equal(result.env.NODE_TEST_CONTEXT, undefined);

  // Reaper scratchpad contract preserved.
  assert.match(result.env.REAPER_SCRATCHPAD ?? "", /reaper|fake-build-child-env/);
  assert.match(result.env.WORKSPACE ?? "", /fake-build-child-env/);
});

test("buildChildEnv honor allowlist entries exactly", () => {
  const workspaceRoot = "/tmp/fake-allowlist";
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: buildFakeSourceEnv(workspaceRoot),
    allowlist: ["GITHUB_TOKEN", "PI_API_KEY"],
  });

  // Allowlisted names kept
  assert.equal(result.env.GITHUB_TOKEN, FAKE_SECRETS.GITHUB_TOKEN);
  assert.equal(result.env.PI_API_KEY, FAKE_SECRETS.PI_API_KEY);
  // Non-allowlisted secrets still stripped
  assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.env.OPENAI_API_KEY, undefined);
  assert.equal(result.env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("buildChildEnv strips credential-bearing URL variables even with creative names", () => {
  const workspaceRoot = "/tmp/fake-url-creds";
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: {
      PATH: "/bin",
      MY_DB_URL: "postgres://app:s3cret@db.example.com/app",
      // PASSWORD is an exact match in SENSITIVE_EXACT.
      PASSWORD: "plaintext",
      MY_HOMEPAGE: "https://user:pass@example.com",
    },
  });

  // MY_DB_URL is stripped (URL with embedded credentials + credential-flavor name)
  assert.equal(result.env.MY_DB_URL, undefined);
  // PASSWORD is stripped (exact SENSITIVE_EXACT match)
  assert.equal(result.env.PASSWORD, undefined);
  // MY_HOMEPAGE — URL with creds but no credential-flavor name — kept.
  // This is intentional: we don't strip arbitrary URLs.
  assert.equal(result.env.MY_HOMEPAGE, "https://user:pass@example.com");
  assert.equal(result.env.PATH?.includes("/bin"), true);
});

// ---------------------------------------------------------------------------
// End-to-end child spawn tests using buildChildEnv output
// ---------------------------------------------------------------------------

test("foreground bash child never sees stripped secrets", async () => {
  const workspaceRoot = await createTempWorkspace();
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: buildFakeSourceEnv(workspaceRoot),
  });

  const child = spawn("/bin/sh", ["-c", "env | sort"], {
    cwd: workspaceRoot,
    env: result.env,
  });

  const stdout = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

  // Stripped secrets MUST NOT appear anywhere in the child's env output.
  for (const [name, value] of Object.entries(FAKE_SECRETS)) {
    assert.equal(stdout.includes(value), false, `stripped secret ${name} leaked into child env`);
  }

  // Benign vars and REAPER scratchpad vars ARE present.
  assert.match(stdout, /LANG=en_US\.UTF-8/);
  assert.match(stdout, /REAPER_SCRATCHPAD=/);
});

test("background bash child receives sanitized environment at spawn", async () => {
  const workspaceRoot = await createTempWorkspace();
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: buildFakeSourceEnv(workspaceRoot),
  });

  // Write a tiny shell script that dumps the env to a file inside
  // the workspace, then run it in the background. This proves the
  // sanitization is applied at SPAWN TIME (the env object passed to
  // spawn), not only at a wrapper layer that might be bypassed.
  const scriptPath = path.join(workspaceRoot, "dump-env.sh");
  const dumpPath = path.join(workspaceRoot, "dumped-env.txt");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(scriptPath, `#!/bin/sh\nenv | sort > "${dumpPath}" &\nsleep 0.5\n`, { mode: 0o755 });

  const child = spawn("/bin/sh", [scriptPath], {
    cwd: workspaceRoot,
    env: result.env,
    detached: true,
  });

  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  // Give the backgrounded env dump a moment to finish.
  await new Promise((r) => setTimeout(r, 500));

  const { readFile } = await import("node:fs/promises");
  const dumped = await readFile(dumpPath, "utf8");

  for (const value of Object.values(FAKE_SECRETS)) {
    assert.equal(dumped.includes(value), false, `stripped secret leaked into background child env`);
  }
});

/*
 * The two tests that stood here ran a JavaScript snippet and a Python snippet
 * through `executeEval` and asserted the child process had been handed a
 * sanitized environment.
 *
 * `eval` is Code Mode now, and Code Mode is real Node: `process`, `require`,
 * `fs`, and `fetch` are all present, because "full platform, no limitations"
 * is the contract. So the property is no longer "there is nothing to read the
 * secrets from". It is the one `bash` has always had, applied to the newest
 * way of running code: the environment the script sees is the sanitized one.
 *
 * Asserted the only way that means anything — by putting a real secret into
 * the real parent environment and then asking the script to find it. A test
 * that only checks the fake fixture would pass whether or not the worker was
 * ever given a sanitized env at all.
 */
test("Code Mode reaches the platform, but not Reaper's environment", async () => {
  const secretName = "ANTHROPIC_API_KEY";
  const secretValue = "canary-value-that-must-not-reach-the-worker";
  const benignName = "REAPER_TEST_BENIGN_MARKER";
  const benignValue = "present-on-purpose";

  /*
   * The expected leak set is computed from Reaper's own classifier rather than
   * hardcoded, so this test cannot drift out of agreement with the thing it is
   * checking. Whatever the parent process is holding that Reaper would call a
   * credential is exactly what must be missing on the other side.
   */
  process.env[secretName] = secretValue;
  process.env[benignName] = benignValue;
  const mustBeAbsent = Object.keys(process.env).filter((name) => isSensitiveEnvName(name, new Set()));
  assert.ok(mustBeAbsent.includes(secretName), "the canary must actually be classified as sensitive for this to prove anything");

  try {
    const probe = await evaluateScript({
      args: {
        code: [
          "report = {};",
          "report.hasProcess = typeof process;",
          "report.hasRequire = typeof require;",
          "report.hasFetch = typeof fetch;",
          "report.visible = Object.keys(process.env);",
          `report.canSeeCanary = typeof process.env[${JSON.stringify(secretName)}];`,
          `report.canSeeBenign = process.env[${JSON.stringify(benignName)}];`,
          "report;",
        ].join("\n"),
      },
      toolCallId: "eval-child-env",
      runId: `child-env-${Math.random().toString(36).slice(2)}`,
      host: emptyCodeHost(),
    });

    const output = probe as { status: string; value: Record<string, unknown> };
    assert.equal(output.status, "completed", JSON.stringify(probe));

    // Full platform. This is the whole point of Code Mode and must not quietly
    // regress back into a sandbox.
    assert.equal(output.value.hasProcess, "object", "`process` must exist — this is real Node");
    assert.equal(output.value.hasRequire, "function", "`require` must exist");
    assert.equal(output.value.hasFetch, "function", "`fetch` must exist");

    // ...and the environment is still Reaper's to control.
    const visible = output.value.visible as string[];
    assert.equal(output.value.canSeeCanary, "undefined", "the host secret reached the worker");
    assert.equal(output.value.canSeeBenign, benignValue, "sanitizing must not empty the environment");
    assert.deepEqual(
      visible.filter((name) => mustBeAbsent.includes(name)),
      [],
      "sensitive variables from the parent environment survived into the worker",
    );
  } finally {
    delete process.env[secretName];
    delete process.env[benignName];
  }
});

test("diagnostic output never prints secret values", () => {
  const workspaceRoot = "/tmp/fake-diag";
  const result = buildChildEnv({
    workspaceRoot,
    sourceEnv: buildFakeSourceEnv(workspaceRoot),
    diagnostics: false, // we don't want stderr noise; check the return shape
  });

  const serialized = JSON.stringify(result);
  for (const value of Object.values(FAKE_SECRETS)) {
    assert.equal(serialized.includes(value), false, `diagnostic summary leaked ${value}`);
  }
});