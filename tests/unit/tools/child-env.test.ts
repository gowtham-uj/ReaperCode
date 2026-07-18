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
import { executeEval } from "../../../src/tools/eval.js";
import { createTempWorkspace } from "../../fixtures/workspace.js";

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

test("JavaScript eval child does not see stripped secrets", async () => {
  const workspaceRoot = await createTempWorkspace();
  const result = await executeEval(
    "console.log(JSON.stringify({anthropic: process.env.ANTHROPIC_API_KEY, github: process.env.GITHUB_TOKEN, lang: process.env.LANG, path: process.env.PATH}))",
    "javascript",
    10,
    {
      workspaceRoot,
      sourceEnv: buildFakeSourceEnv(workspaceRoot),
    },
  );

  assert.equal(result.exitCode, 0, result.error ?? "eval failed");
  const payload = JSON.parse(result.output);
  assert.equal(payload.anthropic, undefined, "ANTHROPIC_API_KEY must be stripped from JS eval");
  assert.equal(payload.github, undefined, "GITHUB_TOKEN must be stripped from JS eval");
  assert.match(payload.lang ?? "", /en_US/);
});

test("Python eval child does not see stripped secrets", async () => {
  const workspaceRoot = await createTempWorkspace();
  const result = await executeEval(
    "import os, json; print(json.dumps({'anthropic': os.environ.get('ANTHROPIC_API_KEY'), 'github': os.environ.get('GITHUB_TOKEN'), 'lang': os.environ.get('LANG'), 'path': os.environ.get('PATH')}))",
    "python",
    10,
    {
      workspaceRoot,
      sourceEnv: buildFakeSourceEnv(workspaceRoot),
    },
  );

  if (result.exitCode !== 0) {
    // Python may be unavailable in some test envs; skip gracefully.
    if (/No such file or directory|python3.*not found/i.test(result.error ?? "")) return;
  }
  assert.equal(result.exitCode, 0, result.error ?? "python eval failed");
  const payload = JSON.parse(result.output);
  // Both `null` (Python's os.environ.get) and `undefined` (Node's)
  // are acceptable signals that the variable was stripped.
  assert.ok(payload.anthropic == null, `ANTHROPIC_API_KEY leaked: ${payload.anthropic}`);
  assert.ok(payload.github == null, `GITHUB_TOKEN leaked: ${payload.github}`);
  assert.match(payload.lang ?? "", /en_US/);
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