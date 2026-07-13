/**
 * exec-runner.test.ts — unit tests for the yolo single-prompt CLI runner.
 *
 * Covers:
 *   - resolveBaseUrl appends /v1 when missing
 *   - resolveBaseUrl keeps /v1 when already present
 *   - resolveBaseUrl defaults to api.anthropic.com/v1 when unset
 *   - buildConfig throws when no auth token is present
 *   - buildConfig injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
 *   - buildConfig uses the model from --model and the default when omitted
 *   - buildConfig produces a ReaperConfig that parses under the strict schema
 *   - ReaperCLI exec group: unknown subcommand → exit 2
 *   - ReaperCLI exec group: missing prompt → exit 2
 *   - ReaperCLI exec group: --prompt positional parsing works
 *
 * No network calls. The runtime path is exercised in a real end-to-end
 * smoke run (see reaper_exec_smoke.mjs / reaper_exec_real2.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveBaseUrl, buildConfig, runExec, buildRequestEnvelope, deriveExecFinalStatus } from "../../../src/adaptive/exec-runner.js";
import { ReaperCLI } from "../../../src/adaptive/cli.js";

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k]!;
  }
  try { return fn(); } finally {
    for (const k of Object.keys(patch)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test("resolveBaseUrl: appends /v1 when missing", () => {
  withEnv({ ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" }, () => {
    assert.equal(resolveBaseUrl(), "https://api.minimax.io/anthropic/v1");
  });
});

test("resolveBaseUrl: keeps /v1 when already present", () => {
  withEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1" }, () => {
    assert.equal(resolveBaseUrl(), "https://api.anthropic.com/v1");
  });
});

test("resolveBaseUrl: strips trailing slash from /v1 base", () => {
  withEnv({ ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1/" }, () => {
    assert.equal(resolveBaseUrl(), "https://api.anthropic.com/v1");
  });
});

test("resolveBaseUrl: default to api.anthropic.com/v1 when unset", () => {
  withEnv({ ANTHROPIC_BASE_URL: undefined }, () => {
    assert.equal(resolveBaseUrl(), "https://api.anthropic.com/v1");
  });
});

test("buildConfig: throws when no auth token is present", () => {
  withEnv({ ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }, () => {
    assert.throws(
      () => buildConfig({ workspaceRoot: "/tmp", prompt: "hi" }),
      /requires ANTHROPIC_AUTH_TOKEN/,
    );
  });
});

test("buildConfig: injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL", () => {
  withEnv(
    { ANTHROPIC_AUTH_TOKEN: "tok-x", ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" },
    () => {
      buildConfig({ workspaceRoot: "/tmp", prompt: "hi" });
      assert.equal(process.env.ANTHROPIC_API_KEY, "tok-x");
      assert.equal(process.env.ANTHROPIC_BASE_URL, "https://api.minimax.io/anthropic/v1");
    },
  );
});

test("buildConfig: uses --model override; default falls back to env or claude-sonnet-4-6", () => {
  withEnv(
    { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_MODEL: undefined, ANTHROPIC_BASE_URL: "https://x" },
    () => {
      const cfg = buildConfig({ workspaceRoot: "/tmp", prompt: "hi", model: "foo-1" }) as { models: { default_model: { model: string } } };
      assert.equal(cfg.models.default_model.model, "foo-1");
    },
  );
  withEnv(
    { ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_MODEL: "env-model", ANTHROPIC_BASE_URL: "https://x" },
    () => {
      const cfg = buildConfig({ workspaceRoot: "/tmp", prompt: "hi" }) as { models: { default_model: { model: string } } };
      assert.equal(cfg.models.default_model.model, "env-model");
    },
  );
});

test("buildConfig: routes every role to default_model without removed guard knobs", () => {
  withEnv({ ANTHROPIC_AUTH_TOKEN: "tok", ANTHROPIC_BASE_URL: "https://x" }, () => {
    const cfg = buildConfig({ workspaceRoot: "/tmp", prompt: "hi" }) as {
      models: { default_model: { capabilities: Record<string, unknown> } };
      runtime: Record<string, unknown>;
      modelRouting: Record<string, string>;
    };
    assert.equal("progressGuard" in cfg.runtime, false);
    assert.equal("completionGateMax" in cfg.runtime, false);
    assert.equal(cfg.models.default_model.capabilities.toolCalling, true);
    for (const role of Object.keys(cfg.modelRouting)) {
      assert.equal(cfg.modelRouting[role], "default_model");
    }
  });
});

test("buildConfig: --provider minimax routes through api.minimax.io + OPENAI_API_KEY", () => {
  withEnv(
    {
      MINIMAX_API_KEY: "sk-mini",
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
    },
    () => {
      const cfg = buildConfig({
        workspaceRoot: "/tmp",
        prompt: "hi",
        provider: "minimax",
      }) as { models: { default_model: { provider: string; apiBase: string; apiKeyEnv: string } } };
      assert.equal(cfg.models.default_model.provider, "minimax");
      assert.equal(cfg.models.default_model.apiBase, "https://api.minimax.io/v1");
      assert.equal(cfg.models.default_model.apiKeyEnv, "OPENAI_API_KEY");
      assert.equal(process.env.OPENAI_API_KEY, "sk-mini");
    },
  );
});

test("buildConfig: --provider nuralwatt seeds NURALWATT_API_KEY and points at NeuralWatt", () => {
  withEnv(
    {
      NURALWATT_API_KEY: "nw-key",
      NURALWATT_API_KEY2: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    () => {
      const cfg = buildConfig({
        workspaceRoot: "/tmp",
        prompt: "hi",
        provider: "nuralwatt",
      }) as { models: { default_model: { provider: string; apiBase: string; apiKeyEnv: string; model: string } } };
      assert.equal(cfg.models.default_model.provider, "nuralwatt");
      assert.equal(cfg.models.default_model.apiBase, "https://api.neuralwatt.com/v1");
      assert.equal(cfg.models.default_model.apiKeyEnv, "NURALWATT_API_KEY");
      assert.equal(cfg.models.default_model.model, "kimi-k2.7-code");
      assert.equal(process.env.NURALWATT_API_KEY, "nw-key");
      assert.equal(process.env.OPENAI_API_KEY, undefined);
    },
  );
});

test("buildConfig: --provider nuralwatt2 seeds NURALWATT_API_KEY2 and points at NeuralWatt", () => {
  withEnv(
    {
      NURALWATT_API_KEY2: "nw-key2",
      NURALWATT_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    () => {
      const cfg = buildConfig({
        workspaceRoot: "/tmp",
        prompt: "hi",
        provider: "nuralwatt2",
      }) as { models: { default_model: { provider: string; apiBase: string; apiKeyEnv: string; model: string } } };
      assert.equal(cfg.models.default_model.provider, "nuralwatt2");
      assert.equal(cfg.models.default_model.apiBase, "https://api.neuralwatt.com/v1");
      assert.equal(cfg.models.default_model.apiKeyEnv, "NURALWATT_API_KEY2");
      assert.equal(cfg.models.default_model.model, "kimi-k2.7-code");
      assert.equal(process.env.NURALWATT_API_KEY2, "nw-key2");
      assert.equal(process.env.OPENAI_API_KEY, undefined);
    },
  );
});

test("buildConfig: --provider deepseek seeds DEEPSEEK_API_KEY and points at api.deepseek.com", () => {
  withEnv(
    {
      DEEPSEEK_API_KEY: "ds-key",
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    () => {
      const cfg = buildConfig({
        workspaceRoot: "/tmp",
        prompt: "hi",
        provider: "deepseek",
        model: "deepseek-chat",
      }) as { models: { default_model: { provider: string; apiBase: string; apiKeyEnv: string; model: string } } };
      assert.equal(cfg.models.default_model.provider, "deepseek");
      assert.equal(cfg.models.default_model.apiBase, "https://api.deepseek.com");
      assert.equal(cfg.models.default_model.apiKeyEnv, "DEEPSEEK_API_KEY");
      assert.equal(cfg.models.default_model.model, "deepseek-chat");
      assert.equal(process.env.DEEPSEEK_API_KEY, "ds-key");
      // OPENAI_API_KEY must NOT be populated for deepseek — the deepseek
      // client reads DEEPSEEK_API_KEY, not the OpenAI env.
      assert.equal(process.env.OPENAI_API_KEY, undefined);
    },
  );
});

test("buildConfig: --provider deepseek throws when no key is available", () => {
  withEnv(
    {
      DEEPSEEK_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
      MINIMAX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    () => {
      assert.throws(
        () => buildConfig({ workspaceRoot: "/tmp", prompt: "hi", provider: "deepseek" }),
        /deepseek requires DEEPSEEK_API_KEY/,
      );
    },
  );
});

test("buildConfig: deepseek does NOT leak its key into MINIMAX_API_KEY or vice versa", () => {
  withEnv(
    {
      DEEPSEEK_API_KEY: "ds-only",
      MINIMAX_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    },
    () => {
      buildConfig({ workspaceRoot: "/tmp", prompt: "hi", provider: "deepseek" });
      assert.equal(process.env.MINIMAX_API_KEY, undefined);
      assert.equal(process.env.DEEPSEEK_API_KEY, "ds-only");
    },
  );
  withEnv(
    {
      MINIMAX_API_KEY: "sk-only",
      DEEPSEEK_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      ANTHROPIC_API_KEY: undefined,
    },
    () => {
      buildConfig({ workspaceRoot: "/tmp", prompt: "hi", provider: "minimax" });
      assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
      assert.equal(process.env.MINIMAX_API_KEY, "sk-only");
    },
  );
});

test("ReaperCLI.exec: unknown subcommand returns exit 2", async () => {
  const cli = new ReaperCLI({ workspaceRoot: "/home/coder", userHome: "/home/coder" });
  const r = await cli.run(["exec", "bogus"]);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /exec subcommand required/);
});

test("ReaperCLI.exec: no subcommand returns exit 2", async () => {
  const cli = new ReaperCLI({ workspaceRoot: "/home/coder", userHome: "/home/coder" });
  const r = await cli.run(["exec"]);
  assert.equal(r.exitCode, 2);
});

test("ReaperCLI.exec: missing --prompt returns exit 2", async () => {
  const cli = new ReaperCLI({ workspaceRoot: "/home/coder", userHome: "/home/coder" });
  const r = await cli.run(["exec", "run"]);
  assert.equal(r.exitCode, 2);
  assert.match(r.stderr, /--prompt/);
});

test("ReaperCLI.exec: missing auth token surfaces a clear error and does not call the network", async () => {
  const cli = new ReaperCLI({ workspaceRoot: "/home/coder", userHome: "/home/coder" });
  await withEnv({ ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await cli.run(["exec", "run", "--prompt", "ping", "--json"]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /ANTHROPIC_AUTH_TOKEN/);
  });
});

test("ReaperCLI.exec: usage line advertises the exec group", async () => {
  const cli = new ReaperCLI({ workspaceRoot: "/home/coder", userHome: "/home/coder" });
  const r = await cli.run([]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /exec\s+run --prompt/);
});

test("runExec: returns failed status when no auth token is set (no network call)", async () => {
  await withEnv({ ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
    const r = await runExec({ workspaceRoot: "/home/coder", prompt: "ping" });
    assert.equal(r.status, "failed");
    assert.equal(r.toolResults.length, 0);
    assert.equal(r.assistantMessage, "");
    assert.match(r.notices.map((n) => n.message).join("\n"), /ANTHROPIC_AUTH_TOKEN/);
  });
});

test("buildRequestEnvelope: yolo system prompt is prepended to user prompt", () => {
  const env = buildRequestEnvelope({
    workspaceRoot: "/tmp/my-build",
    prompt: "build me a thing",
  }) as { payload: { prompt: string } };
  const p = env.payload.prompt;
  assert.match(p, /exec environment/i, "should announce exec environment");
  assert.match(p, /Workspace root:\s+\/tmp\/my-build/, "should interpolate workspace path");
  assert.match(p, /write_file for new files\/full rewrites/, "should warn about source-edit rule");
  assert.match(p, /shell heredocs or redirection/, "should warn about heredoc or redirection source writes");
  assert.match(p, /never prefix the workspace directory/, "should pin workspace-relative path rule");
  assert.match(p, /finish with a concise final assistant message and no tool calls/, "should give the natural-stop rule");
  assert.match(p, /build me a thing/, "user prompt must still be present at the end");
  // ordering: system block first, user prompt last
  assert.ok(p.indexOf("[exec environment") < p.indexOf("build me a thing"), "system block must precede user prompt");
});

test("buildRequestEnvelope: user prompt is preserved verbatim and not double-wrapped", () => {
  const env = buildRequestEnvelope({
    workspaceRoot: "/tmp/x",
    prompt: "line1\nline2\nline3",
  }) as { payload: { prompt: string } };
  const occurrences = (env.payload.prompt.match(/line1\nline2\nline3/g) || []).length;
  assert.equal(occurrences, 1);
});

test("deriveExecFinalStatus: verification.ok=true wins even when abort fired", () => {
  const status = deriveExecFinalStatus({
    aborted: true,
    verification: { ok: true },
    events: [],
  });
  assert.equal(status, "completed");
});

test("deriveExecFinalStatus: verification.ok=false wins even when abort fired", () => {
  const status = deriveExecFinalStatus({
    aborted: true,
    verification: { ok: false },
    events: [],
  });
  assert.equal(status, "failed");
});

test("deriveExecFinalStatus: task_completed event without verification yields completed", () => {
  const status = deriveExecFinalStatus({
    aborted: false,
    verification: undefined,
    events: [{ message_type: "task_completed" }],
  });
  assert.equal(status, "completed");
});

test("deriveExecFinalStatus: aborted with no verification and no task_completed event yields aborted", () => {
  const status = deriveExecFinalStatus({
    aborted: true,
    verification: undefined,
    events: [],
  });
  assert.equal(status, "aborted");
});

test("deriveExecFinalStatus: nothing verified and not aborted yields failed", () => {
  const status = deriveExecFinalStatus({
    aborted: false,
    verification: undefined,
    events: [],
  });
  assert.equal(status, "failed");
});
