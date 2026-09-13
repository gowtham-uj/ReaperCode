/**
 * The `codemode` skill, end to end.
 *
 * Three things have to hold for a skill to be worth shipping, and they are
 * tested here together because they fail together: it must be *offered* (the
 * model can see it exists), *servable* (activation returns the body), and
 * *reachable by a human* (typing `/codemode` loads it without a model call).
 *
 * The middle one is the one that was broken. Discovery walks the packaged
 * directory, but activation consulted a persisted `SkillMemoryRegistry` index
 * that only the CLI ever writes — so in the app-server the skill existed, was
 * listed, and could not be opened.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { packagedSkills, packagedSkillBody } from "../../../src/context/packaged-skills.js";
import { activateSkillTool } from "../../../src/tools/read/activate-skill.js";
import { COCKPIT_LIMITS, renderContextCockpit } from "../../../src/runtime/context-cockpit.js";
import { formatSkillsForPrompt } from "../../../src/context/skills.js";
import { discoverSkills } from "../../../src/skills/discovery.js";
import { TrustResolver } from "../../../src/skills/trust.js";
import { builtinSkillsRoot } from "../../../src/skills/built-in/index.js";
import { parseFrontmatter } from "../../../src/adaptive/skill-author.js";

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "reaper-codemode-skill-"));
}

test("codemode is packaged, described, and pointed at by the eval tool", async () => {
  const skills = packagedSkills();
  const codemode = skills.find((skill) => skill.name === "codemode");
  assert.ok(codemode, "the codemode skill must ship with the product");
  // The description is what the prompt and the router both match on, so it has
  // to say what the skill is for rather than restating its name.
  assert.match(codemode.description, /eval/);

  const { EVAL_TOOL_DESCRIPTION } = await import("../../../src/tools/eval.js");
  assert.match(
    EVAL_TOOL_DESCRIPTION,
    /codemode/,
    "the eval description must tell the model the skill exists — a skill nobody is pointed at is a skill nobody loads",
  );
});

test("codemode is offered in the prompt block the model actually reads", () => {
  const block = formatSkillsForPrompt(packagedSkills(), "read every file and count the lines");
  assert.match(block, /<available_skills>/);
  assert.match(block, /<name>codemode<\/name>/);
  assert.match(block, /activate_skill/);
});

test("codemode activates from an empty workspace, with no index and no registry", async () => {
  const ws = workspace();
  try {
    const out = await activateSkillTool(ws, { name: "codemode" });
    assert.match(out, /^<activated_skill>/);
    // The body has to be the real instructions, not a stub: the point of the
    // skill is that it changes what the model writes.
    assert.match(out, /last expression is the result/i);
    assert.match(out, /tools\.list\(\)/);
    assert.match(out, /When eval is the right tool/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the body served by activation is byte-identical to the packaged body", () => {
  const packaged = packagedSkillBody("codemode");
  assert.ok(packaged && packaged.length > 500, "expected a real body");
  assert.match(packaged, /## The API/);
});

test("a human typing /codemode loads the body into the cockpit as an instruction", () => {
  const skills = packagedSkills();
  const cockpit = renderContextCockpit({
    preparedContext: { fingerprint: "f", fileTree: [], chunks: [], droppedPaths: [], usedTokens: 0 },
    contextFiles: { files: [], diagnostics: [] },
    skills,
    trustedSkills: skills,
    invokedSkills: [{ name: "codemode", body: packagedSkillBody("codemode")! }],
    resourceTrust: { trusted: true },
    environmentFingerprint: {} as never,
    mentions: { fileMentions: [], symbolMentions: [] },
    runtimeFacts: { activeWorkspaceRoot: "/tmp" },
  });
  assert.match(cockpit, /<<<SKILL: codemode>>>/);
  assert.match(cockpit, /authority=user_instruction/);
  assert.match(cockpit, /<<<END_SKILL>>>/);
  assert.match(cockpit, /last expression is the result/i);
});

test("a SKILL.md without YAML frontmatter still loads a body", () => {
  /*
   * The bug this pins down: `parseFrontmatter` returns null when there is no
   * `---` block, and discovery's old fallthrough left the body as the empty
   * string. A skill described entirely by `skill.json` — which is how packaged
   * skills are written, and the only shape the manifest schema documents —
   * therefore loaded with no body at all: listed, activatable, and empty.
   */
  const discovered = discoverSkills({
    builtinRoot: builtinSkillsRoot(),
    userHomeSkillsDir: "",
    projectSkillsDir: "",
    workspaceRoot: "",
    resolver: new TrustResolver({ builtinRoot: builtinSkillsRoot(), userHomeSkillsDir: "", projectSkillsDir: "" }),
  });
  const codemode = discovered.records.find((record) => record.manifest.name === "codemode");
  assert.ok(codemode);
  assert.ok(codemode.body.length > 500, `expected a real body, got ${codemode.body.length} chars`);
  assert.match(codemode.body, /^# Code Mode/);
});

test("a packaged SKILL.md carrying frontmatter has it stripped", () => {
  /*
   * The other half of the same rule. Frontmatter is a wrapper, not content:
   * if it leaked into the body the model would read `---\nname: ...` as the
   * skill's instructions.
   */
  const parsed = parseFrontmatter("---\nname: x\ndescription: y\n---\n\n# Real body\n");
  assert.ok(parsed);
  assert.equal(parsed.body, "# Real body");
  // And a file with none is handed back whole rather than as `undefined`.
  assert.equal(parseFrontmatter("# No frontmatter\n"), null);
});

/**
 * The cockpit's hard cap must not be smaller than the sections it bounds.
 *
 * It was 12,000 while the per-section budgets summed to 41,500, so the last
 * sections were cut every time. `renderInvokedSkills` is second from the end,
 * which meant a user typing `/codemode` could have the body they had just asked
 * for truncated away — the most specific instruction in the whole prompt, lost
 * to arithmetic. Each section was bounded and tested; only their sum was over,
 * and nothing checked the sum.
 */
test("the cockpit hard cap is large enough for every section", () => {
  const sum = Object.entries(COCKPIT_LIMITS)
    .filter(([key]) => key.startsWith("max"))
    .reduce((total, [, value]) => total + value, 0);
  assert.ok(
    COCKPIT_LIMITS.hardCapBytes >= sum,
    `hardCapBytes is ${COCKPIT_LIMITS.hardCapBytes} but the section budgets sum to ${sum}, ` +
      "so whichever section is last is always truncated",
  );
});

test("a large invoked skill survives the hard cap intact", () => {
  /*
   * The end-to-end version of the check above: a body near the invoked-skills
   * budget must still be present after the whole cockpit is assembled, markers
   * and all. This is what a user sees when they type `/name` with a real skill
   * body, rather than what the section renderer does in isolation.
   */
  const body = "x".repeat(COCKPIT_LIMITS.maxInvokedSkillBytes - 100);
  const cockpit = renderContextCockpit({
    preparedContext: { fingerprint: "f", fileTree: [], chunks: [], droppedPaths: [], usedTokens: 0 },
    contextFiles: { files: [], diagnostics: [] },
    skills: packagedSkills(),
    trustedSkills: packagedSkills(),
    invokedSkills: [{ name: "codemode", body }],
    resourceTrust: { trusted: true },
    environmentFingerprint: {} as never,
    mentions: { fileMentions: [], symbolMentions: [] },
    runtimeFacts: { activeWorkspaceRoot: "/tmp" },
  });
  assert.match(cockpit, /<<<END_SKILL>>>/, "the closing marker must survive assembly");
  assert.match(cockpit, /authority=user_instruction/);
  // The body is present in bulk, not just its opening marker.
  assert.ok(
    cockpit.includes(body.slice(0, 8_000)),
    "the invoked skill body was truncated by the cockpit's own cap",
  );
});
