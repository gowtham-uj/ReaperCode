import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { bootPhase0Runtime } from "../../src/runtime/bootstrap.js";

function envelope() {
  return {
    connection_id: "conn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    request_id: "request-1",
    message_type: "user_prompt",
    timestamp: "2026-07-04T00:00:00.000Z",
    trace_id: "trace-1",
    payload: { prompt: "do thing" },
    metadata: {},
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      default_model: {
        provider: "openai",
        model: "gpt-5.4",
        capabilities: { streaming: true, toolCalling: true, jsonMode: true, structuredOutput: true, embeddings: false },
      },
    },
    ...overrides,
  };
}

test("bootPhase0Runtime defaults softCap to 270K when no workspace config exists", () => {
  const dir = path.join(tmpdir(), "reaper-bootstrap-defaults");
  const boot = bootPhase0Runtime({
    config: config(),
    transport: "http_json",
    requestEnvelope: envelope(),
    workspaceRoot: dir,
  });
  assert.equal(boot.state.tokenBudget.softCap, 270_000);
});

test("bootPhase0Runtime uses softCap from parsed contextManagement config", () => {
  const boot = bootPhase0Runtime({
    config: config({ contextManagement: { softCap: 200_000 } }),
    transport: "http_json",
    requestEnvelope: envelope(),
    workspaceRoot: path.join(tmpdir(), "reaper-bootstrap-explicit"),
  });
  assert.equal(boot.state.tokenBudget.softCap, 200_000);
});

test("bootPhase0Runtime clamps softCap above hard cap to 270K", () => {
  const boot = bootPhase0Runtime({
    config: config({ contextManagement: { softCap: 1_000_000 } }),
    transport: "http_json",
    requestEnvelope: envelope(),
    workspaceRoot: path.join(tmpdir(), "reaper-bootstrap-clamp"),
  });
  assert.equal(boot.state.tokenBudget.softCap, 270_000);
});

test("bootPhase0Runtime falls back when .reaper/config.json is malformed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reaper-bootstrap-"));
  await mkdir(path.join(dir, ".reaper"), { recursive: true });
  await writeFile(path.join(dir, ".reaper", "config.json"), "not-json", "utf8");
  const boot = bootPhase0Runtime({
    config: config(),
    transport: "http_json",
    requestEnvelope: envelope(),
    workspaceRoot: dir,
  });
  assert.equal(boot.state.tokenBudget.softCap, 270_000);
});
