import test from "node:test";
import assert from "node:assert/strict";

import { runFreshContextDiffReview } from "../../src/verify/diff-review.js";
import type {
  EmbeddingRequest,
  EmbeddingResult,
  GenerateRequest,
  GenerateResult,
  ModelGateway,
  ModelRole,
  ResolvedModelProfile,
  StreamEvent,
  TokenCountRequest,
} from "../../src/model/types.js";

test("fresh-context diff review accepts a clean judge verdict", async () => {
  const gateway = new StaticJsonGateway({ ok: true, explanation: "Diff matches the task.", discrepancies: [] });

  const result = await runFreshContextDiffReview({
    modelGateway: gateway,
    prompt: "Make answer 42",
    completionSummary: "Changed answer to 42",
    verificationCommand: "npm test",
    verificationOutput: "pass",
    diff: "diff --git a/src/app.ts b/src/app.ts\n-41\n+42\n",
  });

  assert.equal(result.ok, true);
  assert.equal(result.diffReviewed, true);
});

test("fresh-context diff review rejects discrepancies", async () => {
  const gateway = new StaticJsonGateway({ ok: false, explanation: "Wrong file changed.", discrepancies: ["Changed unrelated file"] });

  const result = await runFreshContextDiffReview({
    modelGateway: gateway,
    prompt: "Fix src/app.ts",
    completionSummary: "Changed docs",
    verificationCommand: "npm test",
    verificationOutput: "pass",
    diff: "diff --git a/README.md b/README.md\n-old\n+new\n",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.discrepancies, ["Changed unrelated file"]);
});

class StaticJsonGateway implements ModelGateway {
  constructor(private readonly response: unknown) {}

  async resolveRole(role: ModelRole): Promise<ResolvedModelProfile> {
    return {
      role,
      profileName: role,
      provider: "test",
      model: "static-json",
      capabilities: {
        streaming: false,
        toolCalling: false,
        jsonMode: true,
        structuredOutput: true,
        embeddings: false,
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      content: JSON.stringify(this.response),
      finishReason: "stop",
      raw: this.response,
    };
  }

  async *stream(_request: GenerateRequest): AsyncIterable<StreamEvent> {}

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return {
      role: request.role,
      profileName: request.role,
      provider: "test",
      model: "static-json",
      vectors: (Array.isArray(request.input) ? request.input : [request.input]).map(() => [0]),
      raw: {},
    };
  }

  async countTokens(request: TokenCountRequest): Promise<number> {
    return request.text.length;
  }
}
