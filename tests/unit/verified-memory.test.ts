import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { discoverSkills, rankSkillsForPrompt } from "../../src/context/skills.js";
import { commitVerifiedRunKnowledge, loadVerifiedLessons, recordVerifiedLesson } from "../../src/recovery/verified-memory.js";
import type { ToolResult } from "../../src/tools/types.js";
import { getReaperScratchpadPaths } from "../../src/workspace/scratchpad.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

test("verified lessons are retrieved by relevance, importance, and recency", async () => {
  const workspaceRoot = await createTempWorkspace();
  await recordVerifiedLesson(workspaceRoot, {
    runId: "run-old",
    lesson: "Verified pattern for pytest api work: use focused Python edits and rerun pytest.",
    tags: ["pytest", "api", "python"],
    importance: 1,
    provenance: { groundedSignalKind: "test", changedFileTypes: [".py"] },
  });
  await recordVerifiedLesson(workspaceRoot, {
    runId: "run-new",
    lesson: "Verified pattern for vite frontend work: edit TSX components and run npm test.",
    tags: ["vite", "frontend", "tsx"],
    importance: 3,
    provenance: { groundedSignalKind: "test", changedFileTypes: [".tsx"] },
  });

  const lessons = await loadVerifiedLessons(workspaceRoot, "fix vite frontend component", 2);

  assert.match(lessons[0] ?? "", /vite frontend/);
  assert.doesNotMatch(lessons[0] ?? "", /pytest api/);
});

test("verified run knowledge is not committed without verified completion", async () => {
  const workspaceRoot = await createTempWorkspace();

  const result = await commitVerifiedRunKnowledge({
    workspaceRoot,
    runId: "run-unverified",
    prompt: "Fix app",
    assistantMessage: "done",
    toolResults: [],
    verification: { ok: false },
  });

  assert.equal(result.lesson, undefined);
  await assert.rejects(() => readFile(path.join(getReaperScratchpadPaths(workspaceRoot).memory, "verified-lessons.jsonl"), "utf8"));
});

test("verified run knowledge commits a lesson and discoverable skill", async () => {
  const workspaceRoot = await createTempWorkspace();
  const toolResults: ToolResult[] = [
    {
      toolCallId: "write-1",
      name: "replace_in_file",
      ok: true,
      durationMs: 10,
      args: { path: "src/app.ts", oldString: "41", newString: "42" },
      output: { path: "src/app.ts" },
    },
  ];

  const result = await commitVerifiedRunKnowledge({
    workspaceRoot,
    runId: "run-verified",
    prompt: "Fix TypeScript answer and run tests",
    assistantMessage: "verified",
    toolResults,
    verification: {
      ok: true,
      command: "npm test",
      groundedSignal: { kind: "test", command: "npm test", grounded: true },
    },
  });

  assert.ok(result.lesson);
  assert.ok(result.skill);
  const loaded = await loadVerifiedLessons(workspaceRoot, "typescript tests", 1);
  assert.match(loaded[0] ?? "", /Verified pattern/);
  const skills = discoverSkills(workspaceRoot);
  assert.equal(skills.some((skill) => skill.name === result.skill?.name && skill.verified), true);
});

test("skill ranking prefers relevant verified skills", () => {
  const ranked = rankSkillsForPrompt(
    [
      {
        name: "verified-api",
        description: "Verified backend api pytest workflow",
        filePath: "/tmp/api",
        disableModelInvocation: false,
        verified: true,
        importance: 2,
        tags: ["api", "pytest"],
      },
      {
        name: "verified-ui",
        description: "Verified frontend vite component workflow",
        filePath: "/tmp/ui",
        disableModelInvocation: false,
        verified: true,
        importance: 1,
        tags: ["frontend", "vite"],
      },
    ],
    "fix pytest api endpoint",
  );

  assert.equal(ranked[0]?.name, "verified-api");
});
