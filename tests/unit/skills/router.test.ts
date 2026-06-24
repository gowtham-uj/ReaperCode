/**
 * AC4: Ranks skills from a prompt.
 * The SkillRouter scores candidates by triggers + path patterns +
 * trust tier; returns top-N summaries.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SkillRouter } from "../../../src/skills/router.js";
import type { InstalledSkillRecord } from "../../../src/skills/types.js";

function rec(name: string, category: string, trust: InstalledSkillRecord["trust"], opts: { triggers?: string[]; pathPatterns?: string[] } = {}): InstalledSkillRecord {
  return {
    manifest: {
      name,
      version: "1.0.0",
      description: `Skill for ${name}`,
      category: category as InstalledSkillRecord["manifest"]["category"],
      whenToUse: "always",
      allowedTools: [],
      trust,
      ...(opts.triggers ? { triggers: opts.triggers } : {}),
      ...(opts.pathPatterns ? { pathPatterns: opts.pathPatterns } : {}),
    },
    body: "",
    sourcePath: `/tmp/${name}/SKILL.md`,
    skillDir: `/tmp/${name}`,
    trust,
    scope: trust === "builtin" ? "builtin" : "user",
    installedAt: Date.now(),
    manifestSha256: "deadbeef",
  };
}

test("AC4: ranks skills by triggers + trust", () => {
  const router = new SkillRouter();
  const candidates = [
    rec("typescript-refactor", "typescript-refactor", "builtin", { triggers: ["typescript", "ts"] }),
    rec("python-debugging", "python-debugging", "user-trusted", { triggers: ["python", "py"] }),
    rec("repo-understanding", "repo-understanding", "user-trusted", { triggers: ["repo", "code"] }),
  ];
  const top = router.selectTopN({ query: "typescript refactor", candidates, n: 3 });
  assert.equal(top.length, 3);
  assert.equal(top[0]?.name, "typescript-refactor", "trigger match should win");
  assert.ok(top[0]!.score > top[1]!.score);
});

test("AC4b: path patterns match", () => {
  const router = new SkillRouter();
  const candidates = [
    rec("frontend-react-debugging", "frontend-react-debugging", "user-trusted", { pathPatterns: ["**/*.tsx"] }),
    rec("python-debugging", "python-debugging", "user-trusted", { pathPatterns: ["**/*.py"] }),
  ];
  const top = router.selectTopN({ query: "fix bug", paths: ["src/components/Button.tsx"], candidates, n: 2 });
  assert.equal(top[0]?.name, "frontend-react-debugging");
});
