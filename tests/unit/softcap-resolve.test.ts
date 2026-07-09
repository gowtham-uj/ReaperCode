import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveSoftCap } from "../../src/runtime/bootstrap.js";

test("resolveSoftCap prefers contextManagement.softCap from parsed-like config", () => {
  assert.equal(
    resolveSoftCap({
      config: { contextManagement: { softCap: 42_000 } } as any,
    }),
    42_000,
  );
});

test("resolveSoftCap reads contextManagement.softCap from workspace config.json over tokenBudget", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-softcap-"));
  try {
    mkdirSync(path.join(root, ".reaper"), { recursive: true });
    writeFileSync(
      path.join(root, ".reaper", "config.json"),
      JSON.stringify({ contextManagement: { softCap: 33_000 }, tokenBudget: { softCap: 99_000 } }),
      "utf8",
    );
    assert.equal(resolveSoftCap({ workspaceRoot: root }), 33_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSoftCap falls back to legacy tokenBudget.softCap", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-softcap-legacy-"));
  try {
    mkdirSync(path.join(root, ".reaper"), { recursive: true });
    writeFileSync(
      path.join(root, ".reaper", "config.json"),
      JSON.stringify({ tokenBudget: { softCap: 55_000 } }),
      "utf8",
    );
    assert.equal(resolveSoftCap({ workspaceRoot: root }), 55_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSoftCap defaults when no config present", () => {
  const root = mkdtempSync(path.join(tmpdir(), "reaper-softcap-default-"));
  try {
    assert.equal(resolveSoftCap({ workspaceRoot: root }), 200_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
