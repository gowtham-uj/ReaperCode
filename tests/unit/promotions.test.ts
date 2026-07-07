/**
 * Tests for context/promotions.ts — OMP #21 promote-context-model.
 *
 * In OMP, the auto-compaction path tries to swap to a larger-context
 * sibling model BEFORE compacting. Reaper persists promotions and the
 * engine consults them per model call. These tests verify the
 * round-trip: record → read back → fields preserved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordPromotion, readRecentPromotions, readRecentPromotionsSync, ModelPromotionSchema } from "../../src/context/promotions.js";

test("recordPromotion writes a JSONL line with all fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-prom-"));
  try {
    await recordPromotion(dir, {
      runId: "r1",
      sessionId: "s1",
      timestamp: "2026-07-07T00:00:00.000Z",
      fromRole: "default_model",
      fromProfile: "MiniMax-M3",
      fromContextTokens: 32_768,
      toRole: "secondary_model",
      toProfile: "big-MiniMax-M3",
      toContextTokens: 524_288,
      ratioTrigger: 1.42,
    });
    const file = join(dir, ".reaper", "promotions", "r1.jsonl");
    assert.ok(existsSync(file), "promotion file should exist");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.runId, "r1");
    assert.equal(parsed.fromRole, "default_model");
    assert.equal(parsed.toRole, "secondary_model");
    assert.equal(parsed.fromContextTokens, 32_768);
    assert.equal(parsed.toContextTokens, 524_288);
    assert.equal(parsed.ratioTrigger, 1.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentPromotions returns most-recent first, limit respected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-prom-"));
  try {
    for (let i = 0; i < 5; i += 1) {
      await recordPromotion(dir, {
        runId: "r1",
        sessionId: "s1",
        timestamp: `2026-07-07T00:00:0${i}.000Z`,
        fromRole: "default_model",
        fromProfile: "MiniMax-M3",
        fromContextTokens: 32_768,
        toRole: "secondary_model",
        toProfile: `big-${i}`,
        toContextTokens: 524_288,
        ratioTrigger: 1.0 + i * 0.1,
      });
    }
    const all = readRecentPromotionsSync(dir, "r1", 10);
    assert.equal(all.length, 5);
    // Most recent first (last-written = highest ratioTrigger = 1.4)
    assert.equal(all[0]!.toProfile, "big-4");
    assert.equal(all[0]!.ratioTrigger, 1.4);
    assert.equal(all[4]!.toProfile, "big-0");

    const limited = readRecentPromotionsSync(dir, "r1", 2);
    assert.equal(limited.length, 2);
    assert.equal(limited[0]!.toProfile, "big-4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentPromotions returns [] when no file exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-prom-"));
  try {
    const result = readRecentPromotionsSync(dir, "missing-runId");
    assert.deepEqual(result, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecentPromotions async path returns same data as sync path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-prom-"));
  try {
    await recordPromotion(dir, {
      runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
      fromRole: "default_model", fromProfile: "A", fromContextTokens: 100,
      toRole: "secondary_model", toProfile: "B", toContextTokens: 200, ratioTrigger: 1.5,
    });
    const sync = readRecentPromotionsSync(dir, "r1", 5);
    const async = await readRecentPromotions(dir, "r1", 5);
    assert.deepEqual(sync, async);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed lines are skipped without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reaper-prom-"));
  try {
    // Mix a malformed line with a valid one
    const { mkdir } = await import("node:fs/promises");
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, ".reaper", "promotions");
    await mkdir(file, { recursive: true });
    await writeFile(join(file, "r1.jsonl"),
      "this is not json\n" +
      JSON.stringify({
        runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
        fromRole: "default_model", fromProfile: "A", fromContextTokens: 100,
        toRole: "secondary_model", toProfile: "B", toContextTokens: 200, ratioTrigger: 1.5,
      }) + "\n",
      "utf8",
    );
    const result = readRecentPromotionsSync(dir, "r1", 10);
    assert.equal(result.length, 1, "should skip malformed and return 1 valid");
    assert.equal(result[0]!.toProfile, "B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ModelPromotionSchema accepts canonical role names and rejects unknowns", () => {
  // Canonical role name
  const ok = ModelPromotionSchema.safeParse({
    runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
    fromRole: "default_model", fromProfile: "minimax", fromContextTokens: 100,
    toRole: "secondary_model", toProfile: "gpt-5", toContextTokens: 524_288, ratioTrigger: 0.7,
  });
  assert.equal(ok.success, true, "canonical role names should parse");

  // Legacy alias for fromRole (still accepted via ModelRoleInputSchema)
  const okLegacy = ModelPromotionSchema.safeParse({
    runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
    fromRole: "main_reasoner", fromProfile: "minimax", fromContextTokens: 100,
    toRole: "secondary_model", toProfile: "gpt-5", toContextTokens: 524_288, ratioTrigger: 0.7,
  });
  assert.equal(okLegacy.success, true, "legacy alias 'main_reasoner' should still parse");

  // Unknown role
  const bad = ModelPromotionSchema.safeParse({
    runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
    fromRole: "mainAgent", fromProfile: "minimax", fromContextTokens: 100,
    toRole: "secondary_model", toProfile: "gpt-5", toContextTokens: 524_288, ratioTrigger: 0.7,
  });
  assert.equal(bad.success, false, "modelRole 'mainAgent' (the routing key) is not a valid ModelRole");

  // Unrecognized top-level key
  const strict = ModelPromotionSchema.safeParse({
    runId: "r1", sessionId: "s1", timestamp: "2026-07-07T00:00:00.000Z",
    fromRole: "default_model", fromProfile: "minimax", fromContextTokens: 100,
    toRole: "secondary_model", toProfile: "gpt-5", toContextTokens: 524_288, ratioTrigger: 0.7,
    extraField: "should be rejected by .strict()",
  });
  assert.equal(strict.success, false, "extra fields should be rejected by .strict()");
});
