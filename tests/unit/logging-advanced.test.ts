import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { JsonlStorage } from "../../src/logging/storage.js";
import { redactSecrets } from "../../src/logging/redaction.js";
import { logLangfuseEvent } from "../../src/logging/langfuse.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("redacts obvious secret-like strings", () => {
  const input = {
    OPENAI_API_KEY: "sk-1234567890abcdefghijklmnop",
    header: "Bearer abcdefghijklmnopqrstuvwx123456",
  };
  const redacted = redactSecrets(input) as Record<string, unknown>;

  assert.match(String(redacted.OPENAI_API_KEY), /REDACTED/);
  assert.match(String(redacted.header), /REDACTED/);
});

test("redaction preserves hashes and non-secret workspace identifiers", () => {
  const sha256 = "a".repeat(64);
  const workspace = "reaper-ueval-cd-realworld-webhook-ledger-lROgqL";
  const redacted = redactSecrets({ sha256, workspace }) as Record<string, unknown>;
  assert.equal(redacted.sha256, sha256);
  assert.equal(redacted.workspace, workspace);
});

test("local Langfuse mirrors redact model and tool secrets", async () => {
  const workspaceRoot = await createTempWorkspace();
  const fakeGithubToken = `ghp_${"E".repeat(36)}`;
  await logLangfuseEvent({
    workspaceRoot,
    name: "reaper.test",
    type: "event",
    input: { prompt: `use ${fakeGithubToken}` },
    output: `returned ${fakeGithubToken}`,
    trace: { runId: "run-secret", sessionId: "session-secret" },
  });
  const persisted = await readFile(
    path.join(workspaceRoot, ".reaper", "runs", "run-secret", "logs", "langfuse-events.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(persisted, new RegExp(fakeGithubToken));
  assert.match(persisted, /\[REDACTED:github-token\]/);
});

test("jsonl storage preserves integrity chain across logger instances", async () => {
  const workspaceRoot = await createTempWorkspace();
  const first = new JsonlStorage({ workspaceRoot, filename: "integrity-test.jsonl" });
  await first.append({ event: 1 });

  const second = new JsonlStorage({ workspaceRoot, filename: "integrity-test.jsonl" });
  await second.append({ event: 2 });

  const lines = (await readFile(first.path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { prev_hash: string; entry_hash: string });
  assert.equal(lines[0]?.prev_hash, "root");
  assert.equal(lines[1]?.prev_hash, lines[0]?.entry_hash);
});
