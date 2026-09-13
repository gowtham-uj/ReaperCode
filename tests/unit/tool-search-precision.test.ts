import test from "node:test";
import assert from "node:assert/strict";

import { scoreTool, searchTools, normalizeToolName } from "../../src/context/tool-search.js";
import { CORE_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";

/**
 * The shortlist that decides which deferred tools ride along on every call.
 *
 * This module had no tests, and it rotted in exactly the way an untested
 * scorer does: every prompt substring-matched *something* in *some* tool
 * description, so the shortlist attached a handful of arbitrary deferred tools
 * to every turn. A live run asking only "fetch https://example.com" arrived
 * with `web_fetch` and `memory_search` already attached — nothing was left to
 * discover, and the deferred tool list in the system prompt was a lie.
 *
 * Scoring is fuzzy by nature, so the tests below do not pin exact numbers.
 * They pin the property that matters: a real capability request finds its
 * tool, and ordinary English prose does not drag unrelated tools along.
 */

test("a plain-language prompt does not drag unrelated tools onto the wire", () => {
  // Every one of these is an ordinary request that a user might type. None of
  // them names a tool. The old scorer matched each against several tools purely
  // on function words ("the", "and", "its") or on a single common noun.
  const prompts = [
    "There is a very long log file at reports/build.log and it is too big to read through. Summarise what went wrong in that build.",
    "Can you take a look at how this project is set up and tell me what you find?",
    "I want to refactor the parser so it is easier to reason about.",
    "What does this repository do?",
    "Please review the last commit for anything that looks risky.",
  ];

  for (const prompt of prompts) {
    const selected = searchTools(prompt)
      .map((entry) => entry.name)
      .filter((name) => !CORE_TOOL_NAMES.has(name));

    // A keyword pre-pass is allowed to be generous — the model can still call
    // `search_tools`. What it is not allowed to do is spend context on tools
    // with no relationship to the request, which is what "everything scoring
    // above zero" produced.
    assert.ok(
      selected.length <= 3,
      `"${prompt}" preselected ${selected.length} deferred tools: ${selected.join(", ")}`,
    );
    for (const name of selected) {
      assert.ok(name in toolRegistry, `"${name}" is not a registered tool`);
    }
  }
});

test("function words alone never score a description match", () => {
  // The exact failure: "Fetch the page and tell me its text" matched a hook
  // description containing "the", "and", "its", and "text" — four hits, all
  // meaningless. Each of these prompts is *pure* function words plus one
  // common noun, and none of them asks for any tool at all.
  for (const prompt of [
    "the and for are but not you all this that with from",
    "tell me about the thing and what it does",
    "can you look at this for me",
  ]) {
    for (const [name, spec] of Object.entries(toolRegistry)) {
      assert.equal(
        scoreTool(name, spec.description, prompt),
        0,
        `"${prompt}" scored ${name} without naming a capability`,
      );
    }
  }
});

test("a genuine capability request still finds its tool", () => {
  // The other half of the property: tightening the scorer must not break
  // discovery for prompts that really do describe a capability. These are the
  // same phrasings the live harness uses.
  const cases: Array<{ prompt: string; tool: string }> = [
    { prompt: "Fetch https://example.com and tell me the text of its first heading.", tool: "web_fetch" },
    { prompt: "Search the web for the latest stable major version of zod.", tool: "web_search" },
    { prompt: "Delete src/obsolete.ts, it is dead code and nothing imports it.", tool: "delete_file" },
    {
      prompt: "Create a recoverable checkpoint of the current state before I make risky edits.",
      tool: "create_checkpoint",
    },
    {
      prompt: "Tell me what runtimes, package managers and dependency manifests this project has.",
      tool: "inspect_environment",
    },
    { prompt: "Find the line that declares resolveTransport in src/large.ts.", tool: "file_find" },
    {
      prompt: "Run whatever post-write diagnostics are configured for src/broken.ts.",
      tool: "diagnostics",
    },
    { prompt: "Apply this unified diff to the workspace, changing both files at once.", tool: "apply_patch_edit" },
  ];

  for (const { prompt, tool } of cases) {
    const selected = searchTools(prompt).map((entry) => entry.name);
    assert.ok(
      selected.includes(tool),
      `"${prompt}" should surface ${tool}; got ${selected.filter((n) => !CORE_TOOL_NAMES.has(n)).join(", ") || "nothing beyond core"}`,
    );
  }
});

test("naming a tool outright always matches it", () => {
  // `search_tools select:<name>` and any prompt that spells the tool out must
  // resolve regardless of how the scoring floor moves.
  for (const name of ["glob", "job", "web_fetch", "inspect_environment", "apply_patch_edit"]) {
    const spec = toolRegistry[name as keyof typeof toolRegistry];
    assert.equal(
      scoreTool(name, spec.description, name),
      100,
      `exact name "${name}" must short-circuit to a certainty`,
    );
    assert.equal(scoreTool(name, spec.description, normalizeToolName(name)), 100);
  }
});

test("punctuation on a word does not stop it matching", () => {
  // Real prompts carry punctuation: "src/config.ts," and "do not." A trailing
  // comma used to be enough to break a name match entirely.
  const withPunctuation = scoreTool(
    "delete_file",
    toolRegistry.delete_file.description,
    "delete_file,",
  );
  assert.ok(withPunctuation > 0, "a trailing comma must not defeat an exact name match");

  assert.ok(
    searchTools("Delete src/obsolete.ts, it is dead code.").some((entry) => entry.name === "delete_file"),
    "punctuated prose must still reach the tool it names",
  );
});

test("the shortlist never exceeds its budget", () => {
  // It runs before every turn, so an unbounded result would undo progressive
  // disclosure on the first call of every run.
  const selected = searchTools(
    "read write edit delete search find list view run fetch apply checkpoint restore skill hook extension eval job",
  );
  assert.ok(selected.length <= 8, `shortlist returned ${selected.length} entries`);
});

test("disabled tools are still findable by the scorer, filtered by the caller", () => {
  // `searchTools` itself does not know about per-thread disables — the engine
  // filters afterwards. Pinning the split here so a future change does not
  // "fix" the scorer by teaching it about a concern it does not own.
  const selected = searchTools("fetch a web page");
  assert.ok(selected.length > 0, "the scorer must return candidates regardless of thread policy");
});
