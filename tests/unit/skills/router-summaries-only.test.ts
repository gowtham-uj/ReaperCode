/**
 * AC5: Does not load all skill bodies into context.
 * The SkillRouter returns `SkillSummary` which has no `body` field.
 * Compile-time check: the type system prevents any code from reading
 * `summary.body` because no such field exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRouter } from "../../../src/skills/router.js";
import type { InstalledSkillRecord } from "../../../src/skills/types.js";
import type { SkillSummary } from "../../../src/skills/types.js";

test("AC5: summary has no body field", () => {
  const router = new SkillRouter();
  const rec: InstalledSkillRecord = {
    manifest: {
      name: "x",
      version: "1.0.0",
      description: "x",
      category: "bug-fixing",
      whenToUse: "x",
      allowedTools: [],
      trust: "builtin",
    },
    body: "SENSITIVE BODY CONTENT",
    sourcePath: "/tmp/x/SKILL.md",
    skillDir: "/tmp/x",
    trust: "builtin",
    scope: "builtin",
    installedAt: Date.now(),
    manifestSha256: "x",
  };
  const [summary] = router.selectTopN({ query: "x", candidates: [rec] });
  assert.ok(summary);
  // Body is intentionally absent from SkillSummary; assert that.
  const summaryRecord = summary as unknown as Record<string, unknown>;
  assert.equal(summaryRecord.body, undefined, "summary must not carry the body");
  // Sanity: fields the router DOES return.
  assert.equal(summary?.name, "x");
  assert.equal(summary?.trust, "builtin");
  // Type-level guarantee (compile-time only; the test confirms the shape).
  const typeGuard: SkillSummary = summary!;
  assert.equal(typeof typeGuard.score, "number");
});
