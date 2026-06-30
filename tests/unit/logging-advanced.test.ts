import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { JsonlStorage } from "../../src/logging/storage.js";
import { redactSecrets } from "../../src/logging/redaction.js";
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
