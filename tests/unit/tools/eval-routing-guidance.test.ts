/**
 * The guidance that routes a task to eval, pinned in every place a model reads.
 *
 * Audited: `eval` is core (its schema ships on every request), its sandbox works
 * (14/14 confinement tests), and across every session journal on this machine
 * there was not one eval call. The tool was reachable and correct; the routing
 * was not written where the model looks.
 *
 * The failure mode here is silent, which is why it needs a test rather than a
 * comment: guidance can be edited away or reordered and nothing fails. The tool
 * simply stops being used, and the cost shows up as a run that spends forty tool
 * calls doing what one program would have done, with no error anywhere to point
 * at. This is the same contract `documented-controls.test.ts` holds for the
 * browser: a fix a model does not know about is a fix it does not use.
 *
 * Three surfaces, and each is asserted because they serve different moments:
 *
 *   1. The system prompt, which every turn carries. It is the only place the
 *      routing is guaranteed to be read, and it had nothing about eval.
 *   2. The tool description, which is read when the model is weighing the call.
 *   3. The skill, which is the detail behind the routing when it is loaded.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { EVAL_TOOL_DESCRIPTION } from "../../../src/tools/eval.js";
import { MAIN_AGENT_SYSTEM_PROMPT_TEXT } from "../../../src/runtime/system-prompt.js";
import { CORE_TOOL_NAMES } from "../../../src/tools/registry.js";

const SKILL_PATH = new URL("../../../src/skills/built-in/codemode/SKILL.md", import.meta.url);
const SKILL_PATH_CM = SKILL_PATH;

test("eval is a core tool, so its schema ships without a discovery step", () => {
  /*
   * The precondition for everything else. If eval were deferred, a model would
   * have to know to look for it, and no amount of prompt guidance fixes a tool
   * whose schema never arrives.
   */
  assert.ok(CORE_TOOL_NAMES.has("eval"), "eval must be core, or it cannot be reached before its first use");
});

test("the system prompt says when to write a program", () => {
  /*
   * The surface that was empty. Its absence is the whole finding: the routing
   * lived only in a tool description and a skill, so a model could go a whole
   * run without ever being told eval was the right shape for its loop.
   */
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /Reach for eval/, "the prompt must name eval as the choice for a program");
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /same operation over many items|loop or fan-out/, "and say what shape of task wants it");
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /tools\.\*/, "and that the thread's tools are reachable inside it");
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /Promise\.all/, "and that it has real concurrency");
});

test("the system prompt names the confusion that costs the most", () => {
  /*
   * Smuggling a program through bash. This is the specific wrong turn the audit
   * was about, and it is worse than a lost optimisation: an interpreter run
   * through bash leaves the sandbox, its inner calls never reach the audit log or
   * the transcript, and it cannot use a single tool.
   */
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /NEVER spell a program as `?bash/, "the prohibition must be stated");
  for (const spelling of ["node -e", "node --input-type", "heredoc", "python -c"]) {
    assert.match(
      MAIN_AGENT_SYSTEM_PROMPT_TEXT,
      new RegExp(spelling.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")),
      `the prompt must name "${spelling}" as the wrong way to run a program`,
    );
  }
});

test("the prompt's positive case must not be preceded by its prohibitions", () => {
  /*
   * The ordering, asserted because it was the measured bias. The description
   * used to open with two "Do not use eval" paragraphs and reach "Use eval
   * when..." third, so a reader deciding whether the tool fit had to pass two
   * refusals first. A model is choosing when it reads this, and the answer to
   * "is this for me" has to come before the answer to "when not".
   */
  const prompt = MAIN_AGENT_SYSTEM_PROMPT_TEXT;
  const positive = prompt.indexOf("Reach for eval");
  const negative = prompt.indexOf("NEVER spell a program as");
  assert.ok(positive !== -1 && negative !== -1, "both halves must be present");
  assert.ok(positive < negative, "the case for eval must be read before the case against it");
});

test("the tool description leads with what eval is for", () => {
  /*
   * The same ordering rule for the description, and it is the one the model
   * reads while weighing the call. `Use eval when` must come before the first
   * `Do not use eval`.
   */
  const useAt = EVAL_TOOL_DESCRIPTION.indexOf("Use eval when");
  const guardAt = EVAL_TOOL_DESCRIPTION.indexOf("Do not use eval");
  assert.ok(useAt !== -1, "the description must say when to use it");
  assert.ok(guardAt !== -1, "and still carry the guards that stop over-use");
  assert.ok(useAt < guardAt, `"when to use" must precede "when not to", got use@${useAt} guard@${guardAt}`);
});

test("the description keeps every guard the audit found useful", () => {
  /*
   * The guards are not the problem and must survive the reordering. Each one
   * names a case where eval is a straight loss, and dropping one would trade
   * under-use for over-use.
   */
  for (const guard of [
    /single ordinary operation/,
    /do not use eval when you need to see a result/i,
  ]) {
    assert.match(EVAL_TOOL_DESCRIPTION, guard, `the guard ${guard} must be kept`);
  }
  // And the bash prohibition, which is the routing mistake that costs the most.
  assert.match(EVAL_TOOL_DESCRIPTION, /NEVER write a program as `bash`/, "the description must forbid the bash spelling too");
});

test("the skill documents the routing in detail", async () => {
  /*
   * The third surface, and the one that carries the worked detail. It is only
   * reachable if the model loads it, so it reinforces the prompt rather than
   * replacing it.
   */
  const skill = await readFile(SKILL_PATH, "utf8");
  assert.match(skill, /When eval is the right tool/, "the skill must have a routing section");
  assert.match(skill, /When it is not/, "and the counter-case");
  assert.match(skill, /same call repeated over a list|for. loop/i, "and name the loop shape concretely");
});

test("the model is told it can save a script and run it later", async () => {
  /*
   * A feature the model does not know about is a feature it does not use, and
   * saving is exactly that shape: it existed, worked, and was documented only in
   * the schema, where a model reading a routing decision looks last.
   *
   * Three surfaces, because they are read at different moments: the prompt while
   * deciding whether a task is script-shaped at all, the description while
   * weighing this particular call, and the skill while writing the script.
   */
  assert.match(EVAL_TOOL_DESCRIPTION, /save: "name"/, "the description must show how to save");
  assert.match(EVAL_TOOL_DESCRIPTION, /script: "name"/, "and how to run one back");
  assert.match(EVAL_TOOL_DESCRIPTION, /list what this thread has saved/, "and how to see what exists");

  assert.match(
    MAIN_AGENT_SYSTEM_PROMPT_TEXT,
    /save: "name"/,
    "the prompt must name saving, or a model will write the same script twice",
  );
  assert.match(MAIN_AGENT_SYSTEM_PROMPT_TEXT, /script: "name"/, "and how to re-run one");

  const skill = await readFile(SKILL_PATH_CM, "utf8");
  assert.match(skill, /## Keeping a script/, "the skill must have a section for it");
  assert.match(skill, /save: "count-todos"/, "with a worked example");
});
