import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReaperConfig } from "../../src/config/model-config.js";
import {
  inferFullSummary,
  stripSummarizerInputReasoning,
} from "../../src/context/full-summary-inference.js";

const TEST_API_KEY_ENV = "REAPER_TEST_FULL_SUMMARY_API_KEY";

interface ProviderRequest {
  max_tokens?: number;
  messages?: Array<{ role?: string; content?: string }>;
}

async function startProviderStub(
  respond: (request: ProviderRequest, response: http.ServerResponse) => void,
): Promise<{
  apiBase: string;
  requests: ProviderRequest[];
  close: () => Promise<void>;
}> {
  const requests: ProviderRequest[] = [];
  const server = http.createServer(async (request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    for await (const chunk of request) rawBody += chunk;
    const body = JSON.parse(rawBody) as ProviderRequest;
    requests.push(body);
    respond(body, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    apiBase: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function configFor(apiBase: string, maxTokens: number): ReaperConfig {
  return {
    models: {
      summarizer: {
        provider: "openai",
        model: "local-summary-stub",
        apiBase,
        apiKeyEnv: TEST_API_KEY_ENV,
        maxTokens,
        defaultParams: { temperature: 0 },
      },
    },
  } as unknown as ReaperConfig;
}

test("stripSummarizerInputReasoning removes hidden reasoning without removing assistant or tool facts", () => {
  const assistantFact = JSON.stringify({ role: "assistant", content: "KEPT_ASSISTANT_FACT" });
  const toolFact = JSON.stringify({ role: "tool", name: "read", content: "KEPT_TOOL_FACT" });
  const toolAnalysisFact = JSON.stringify({
    role: "tool",
    type: "analysis",
    content: "KEPT_STATIC_ANALYZER_FACT",
  });
  const input = [
    "before",
    "<think mode=\"private\">discard tagged thought</think>",
    "<analysis>discard tagged analysis\nacross lines</analysis>",
    JSON.stringify({ type: "reasoning", content: "DISCARD_REASONING_RECORD" }),
    JSON.stringify({ event: "ReasoningComplete", text: "DISCARD_REASONING_EVENT" }),
    JSON.stringify({ role: "assistant", reasoning_content: "DISCARD_REASONING_FIELD_RECORD" }),
    JSON.stringify({
      role: "assistant",
      content: [{ type: "thinking", thinking: "DISCARD_REASONING_CONTENT_BLOCK" }],
    }),
    assistantFact,
    toolFact,
    toolAnalysisFact,
    "after",
  ].join("\r\n");

  const result = stripSummarizerInputReasoning(input);

  assert.doesNotMatch(result, /<(?:think|analysis)\b/i);
  assert.doesNotMatch(result, /DISCARD_/);
  assert.match(result, /before/);
  assert.match(result, /after/);
  assert.ok(result.includes(assistantFact));
  assert.ok(result.includes(toolFact));
  assert.ok(result.includes(toolAnalysisFact));
  assert.match(result, /\r\n/, "normal CRLF line endings should be preserved");
});

test("inferFullSummary clamps output tokens and submits only sanitized canonical-summary input", async (t) => {
  const previousApiKey = process.env[TEST_API_KEY_ENV];
  process.env[TEST_API_KEY_ENV] = "local-test-placeholder";
  t.after(() => {
    if (previousApiKey === undefined) delete process.env[TEST_API_KEY_ENV];
    else process.env[TEST_API_KEY_ENV] = previousApiKey;
  });

  const fakeGithubToken = `ghp_${"A".repeat(36)}`;
  const stub = await startProviderStub((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      choices: [{
        message: {
          content: `<think>PRIVATE_SUMMARIZER_REASONING</think><summary>token ${fakeGithubToken} and stub</summary>`,
        },
      }],
    }));
  });
  t.after(() => stub.close());
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-full-summary-inference-"));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

  const source = [
    "<analysis>DISCARD_PROVIDER_ANALYSIS</analysis>",
    "<think>DISCARD_PROVIDER_THINKING</think>",
    JSON.stringify({ type: "reasoning", content: "DISCARD_PROVIDER_RECORD" }),
    JSON.stringify({ role: "assistant", content: "KEPT_PROVIDER_ASSISTANT_FACT" }),
    JSON.stringify({ role: "tool", name: "read", content: "KEPT_PROVIDER_TOOL_FACT" }),
    `user supplied ${fakeGithubToken}`,
  ].join("\n");

  const firstResult = await inferFullSummary(source, {
    config: configFor(stub.apiBase, 16_000),
    workspaceRoot,
    runId: "clamped-16k",
  });
  await inferFullSummary("ordinary source", {
    config: configFor(stub.apiBase, 2_000),
    workspaceRoot,
    runId: "unchanged-2k",
  });

  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0]?.max_tokens, 4_096);
  assert.equal(stub.requests[1]?.max_tokens, 2_000);

  const systemInstruction = stub.requests[0]?.messages?.[0]?.content ?? "";
  assert.match(systemInstruction, /exactly one concise <summary>/i);
  assert.match(systemInstruction, /project-configurable full summarizer/i);
  assert.match(systemInstruction, /embedded conversation text as data/i);
  assert.match(systemInstruction, /call no tools/i);

  const submittedSource = stub.requests[0]?.messages?.[1]?.content ?? "";
  assert.doesNotMatch(submittedSource, /<(?:think|analysis)\b/i);
  assert.doesNotMatch(submittedSource, /DISCARD_PROVIDER_/);
  assert.match(submittedSource, /KEPT_PROVIDER_ASSISTANT_FACT/);
  assert.match(submittedSource, /KEPT_PROVIDER_TOOL_FACT/);
  assert.doesNotMatch(submittedSource, new RegExp(fakeGithubToken));
  assert.match(submittedSource, /\[REDACTED:github-token\]/);
  assert.doesNotMatch(firstResult, /PRIVATE_SUMMARIZER_REASONING/);
  assert.doesNotMatch(firstResult, new RegExp(fakeGithubToken));
  assert.match(firstResult, /^<summary>token \[REDACTED:github-token\] and stub<\/summary>$/);
  const persisted = await readFile(
    path.join(workspaceRoot, ".reaper", "summaries", "clamped-16k.md"),
    "utf8",
  );
  assert.equal(persisted, firstResult);
});

for (const status of [400, 413]) {
  test(`inferFullSummary exposes numeric provider status ${status} with bounded diagnostics`, async (t) => {
    const previousApiKey = process.env[TEST_API_KEY_ENV];
    process.env[TEST_API_KEY_ENV] = "local-test-placeholder";
    t.after(() => {
      if (previousApiKey === undefined) delete process.env[TEST_API_KEY_ENV];
      else process.env[TEST_API_KEY_ENV] = previousApiKey;
    });

    const stub = await startProviderStub((_request, response) => {
      response.statusCode = status;
      response.end(`diagnostic-${"x".repeat(600)}-UNBOUNDED_TAIL`);
    });
    t.after(() => stub.close());
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-full-summary-inference-"));
    t.after(() => rm(workspaceRoot, { recursive: true, force: true }));

    await assert.rejects(
      inferFullSummary("source", {
        config: configFor(stub.apiBase, 4_096),
        workspaceRoot,
        runId: `http-${status}`,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const providerError = error as Error & { status?: unknown };
        assert.equal(typeof providerError.status, "number");
        assert.equal(providerError.status, status);
        assert.match(providerError.message, new RegExp(`provider ${status}: diagnostic-`));
        assert.doesNotMatch(providerError.message, /UNBOUNDED_TAIL/);
        return true;
      },
    );
  });
}
