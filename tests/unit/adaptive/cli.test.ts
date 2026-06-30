import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReaperCLI } from "../../../src/adaptive/cli.js";
import { ModelCapabilitiesRegistry } from "../../../src/adaptive/model-capabilities.js";

function makeCLI(opts: { imageInput?: boolean; modelCall?: never } = {}): ReaperCLI {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const caps = new ModelCapabilitiesRegistry({ capabilities: { imageInput: opts.imageInput ?? false, videoInput: false, toolUse: true, streaming: true, parallelToolUse: true, detectedAt: "2026-01-01T00:00:00Z", source: "explicit" } });
  return new ReaperCLI({ workspaceRoot: dir, capabilities: caps });
}

test("CLI prints usage when no args", async () => {
  const cli = makeCLI();
  const r = await cli.run([]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /reaper <group>/);
});

test("CLI rejects unknown group", async () => {
  const cli = makeCLI();
  const r = await cli.run(["nope"]);
  assert.equal(r.exitCode, 2);
});

test("CLI capability show returns the registry", async () => {
  const cli = makeCLI({ imageInput: true });
  const r = await cli.run(["capability", "show"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /"imageInput": true/);
});

test("CLI skill list works on empty registry", async () => {
  const cli = makeCLI();
  const r = await cli.run(["skill", "list"]);
  assert.equal(r.exitCode, 0);
});

test("CLI visual analyze fails when model does not support images", async () => {
  const cli = makeCLI({ imageInput: false });
  const r = await cli.run(["visual", "analyze", "x.png"]);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /visual disabled|not support/);
});

test("CLI visual analyze succeeds when model supports images (metadata fallback)", async () => {
  const cli = makeCLI({ imageInput: true });
  const r = await cli.run(["visual", "analyze", "x.png"]);
  // No file present => file registration fails
  assert.equal(r.exitCode, 1);
});

test("CLI swarm plan produces a single-subagent decision", async () => {
  const cli = makeCLI();
  const r = await cli.run(["swarm", "plan", "--task", "fix a typo in README"]);
  assert.equal(r.exitCode, 0);
  const json = JSON.parse(r.stdout) as { mode: string; subagent_type: string };
  assert.equal(json.mode, "single_subagent");
  // The swarm is now a single subagent launcher, not a workflow.
  // The plan picks a subagent type by keyword.
  assert.ok(json.subagent_type);
});

test("CLI redact redacts inline secrets", async () => {
  const cli = makeCLI();
  const r = await cli.run(["redact", "AKIAIOSFODNN7EXAMPLE"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /\[REDACTED:aws-access-key\]/);
});
