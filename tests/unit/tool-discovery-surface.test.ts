/**
 * The two halves of progressive tool discovery have to agree.
 *
 * `buildGeneralAgentTools` decides what the model is *offered*; the inventory
 * appended to the system prompt decides what the model *knows exists*; the
 * executor decides what it will *honour*. Each of those was, at some point,
 * answering a different question from the other two — a tool that could be
 * searched for but was refused on call, or a tool that existed but was never
 * mentioned. These tests pin the three answers together.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { buildGeneralAgentTools } from "../../src/runtime/agent-tools.js";
import { renderAvailableTools, selectGeneralAgentToolsForTurn } from "../../src/runtime/engine.js";
import { CORE_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";
import { discoverTools, clearDiscoveredTools, getDiscoveredTools } from "../../src/tools/discovery.js";
import { executeSearchTools } from "../../src/tools/write/search-tools.js";

/** Words that read as a broken sentence when nothing follows them. */
const DANGLING_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "for", "from", "with", "by",
  "as", "at", "on", "into", "that", "which", "is", "are", "be", "then", "so",
]);

test("the model is told which tools exist beyond the core set", () => {
  const runId = "inventory-basic";
  clearDiscoveredTools(runId);
  const block = renderAvailableTools(runId);

  assert.ok(block.length > 0, "a deferred set that exists must be announced");
  // Every tool outside the core set is named, so nothing is unreachable by
  // reading the prompt alone.
  for (const name of Object.keys(toolRegistry)) {
    if (CORE_TOOL_NAMES.has(name)) continue;
    assert.match(block, new RegExp(`\\b${name}:`), `${name} is missing from the inventory`);
  }
  // And the core set is not repeated back at the model, which already holds
  // full schemas for those.
  for (const name of CORE_TOOL_NAMES) {
    if (name === "search_tools") continue;
    assert.doesNotMatch(block, new RegExp(`^  - ${name}:`, "m"), `${name} is core and should not be listed`);
  }
});

test("a discovered tool leaves the inventory on the next call", () => {
  const runId = "inventory-promotion";
  clearDiscoveredTools(runId);
  assert.match(renderAvailableTools(runId), /^  - web_search:/m);

  discoverTools(["web_search"], runId);

  // Still named — it is now offered directly, so leaving it in the "unlock
  // this" list would tell the model to go and fetch what it already has.
  const after = renderAvailableTools(runId);
  assert.doesNotMatch(after, /^  - web_search:/m);
  assert.ok(buildGeneralAgentTools([...new Set(["web_search"])]).some((tool) => tool.name === "web_search"));
});

test("every inventory line is a whole, readable sentence", () => {
  // The test above proves each tool is *named*. This one proves the line after
  // the name is worth reading.
  //
  // `slice(0, 110)` severed a word in 17 of the 20 entries — `paths be`,
  // `mutation batch. Stores met`, `Supports new file creation (--- /d`. Naming
  // a tool and then describing it in mangled text is a worse failure than not
  // describing it at all, because the model has no way to tell a truncated
  // description from a complete one and will decide whether to spend a
  // discovery call on what it was shown.
  const runId = "inventory-legibility";
  clearDiscoveredTools(runId);
  const lines = renderAvailableTools(runId)
    .split("\n")
    .filter((line) => line.startsWith("  - "));

  const openingLines = new Map(
    Object.entries(toolRegistry).map(([name, spec]) => [name, spec.description.split("\n")[0]!.trim()]),
  );

  assert.equal(lines.length, Object.keys(toolRegistry).length - CORE_TOOL_NAMES.size);
  for (const line of lines) {
    const name = line.slice(4, line.indexOf(":"));
    const summary = line.slice(line.indexOf(":") + 2);
    const full = openingLines.get(name);
    assert.ok(full !== undefined, `${name} is listed in the inventory but is not a registered tool`);

    assert.ok(summary.length > 0, `${name} is named with no description at all`);

    if (summary.length >= full.length) {
      assert.equal(summary, full, `${name} rewrote a description that needed no truncation`);
      continue;
    }

    // A shortened line has to say it was shortened. This is the assertion that
    // catches the original bug: `slice(0, 110)` produced a line that simply
    // stopped, and the model had no way to tell it from a complete one.
    assert.ok(summary.endsWith(" …"), `${name} was truncated without a marker: ${JSON.stringify(summary)}`);

    const body = summary.slice(0, -2);
    const lastWord = body.split(" ").at(-1)!.toLowerCase().replace(/[.,;:!?]$/, "");
    assert.ok(
      !DANGLING_WORDS.has(lastWord),
      `${name} ends on '${lastWord}', which only makes sense with text after it`,
    );
    assert.ok(!/[(\[{]$/.test(body), `${name} was cut inside a bracket: ${JSON.stringify(body.slice(-24))}`);

    // The retained text must be exactly the opening of the real description —
    // a summary that quietly reworded a tool would be describing a different
    // tool than the one `search_tools` will hand over.
    assert.ok(
      full.startsWith(body.replace(/[.,;:!?]$/, "")),
      `${name}'s summary is not an opening of its description:\n  summary: ${body}\n  actual:  ${full}`,
    );
  }
});

test("discovering every deferred tool leaves no inventory to render", () => {
  const runId = "inventory-exhausted";
  clearDiscoveredTools(runId);
  discoverTools(Object.keys(toolRegistry), runId);
  assert.equal(renderAvailableTools(runId), "");
});

test("a tool switched off for the thread is not offered, advertised, or searchable", () => {
  const runId = "disabled-tool-surfaces";
  clearDiscoveredTools(runId);
  const disabled = new Set(["web_search"]);

  const offered = buildGeneralAgentTools([], disabled).map((tool) => tool.name);
  assert.ok(!offered.includes("web_search"), "a disabled tool must not be offered");

  // The inventory is generated from the registry, so it would list a disabled
  // tool unless it is filtered — which sends the model to search for something
  // that will then be refused.
  // Not advertised either: the inventory is built from the same registry, and
  // naming a tool the thread switched off sends the model to search for
  // something that will then be refused.
  assert.doesNotMatch(renderAvailableTools(runId, disabled), /^  - web_search:/m);

  const result = executeSearchTools("select:web_search", runId, disabled);
  assert.deepEqual(result.discovered, [], "a disabled tool must not be promotable");
  assert.equal(result.total_tools, Object.keys(toolRegistry).length - 1);

  const keyword = executeSearchTools("search the web for documentation", runId, disabled);
  assert.ok(!keyword.matches.some((match) => match.name === "web_search"), "BM25 must filter disabled tools too");
});

test("the offered surface and the advertised surface never disagree", () => {
  const runId = "inventory-agreement";
  clearDiscoveredTools(runId);
  const offered = new Set(buildGeneralAgentTools([], new Set()).map((tool) => tool.name));
  const block = renderAvailableTools(runId);

  for (const name of Object.keys(toolRegistry)) {
    const advertised = new RegExp(`^  - ${name}:`, "m").test(block);
    assert.ok(
      offered.has(name) || advertised,
      `${name} is neither offered nor advertised, so it is unreachable`,
    );
    assert.ok(
      !(offered.has(name) && advertised),
      `${name} is both offered and advertised, which tells the model to unlock what it already has`,
    );
  }
});

test("a promotion survives the per-turn tool selection", () => {
  // The path from "the model asked for this" to "the model holds a schema for
  // it" is four hops long: `search_tools` writes to the discovery store, the
  // store feeds `buildGeneralAgentTools`, and that result goes through
  // `selectGeneralAgentToolsForTurn` before it reaches the wire. Every hop has
  // its own tests; this one is the join.
  //
  // It exists because the join was broken. `selectGeneralAgentToolsForTurn`
  // narrows the list for build-like tasks, and its narrowing rebuilt the wire
  // from a fixed set of names — so for the first twenty writes of any build
  // task, a promotion was granted, announced, and then silently discarded
  // before it could reach the model.
  const buildRequest = {
    payload: {
      prompt: "Build a production-style full-stack app with apps/api, apps/web, packages/shared, tests, and docs.",
    },
  };

  for (const writes of [0, 5, 19, 20]) {
    const runId = `promotion-survives-turn-select-${writes}`;
    clearDiscoveredTools(runId);
    executeSearchTools("select:create_checkpoint", runId);

    const selected = selectGeneralAgentToolsForTurn({
      request: buildRequest as never,
      state: {
        toolResults: Array.from({ length: writes }, (_, index) => ({
          ok: true,
          name: "write_file",
          args: { path: `file-${index}.ts` },
        })),
      } as never,
      tools: buildGeneralAgentTools(getDiscoveredTools(runId)),
    }).map((tool) => tool.name);

    assert.ok(
      selected.includes("create_checkpoint"),
      `create_checkpoint was promoted but is not on the wire after ${writes} writes`,
    );
    // And the inventory agrees with the wire, which is the other half of the
    // contract: a tool on the wire must not still be advertised as locked.
    assert.doesNotMatch(
      renderAvailableTools(runId),
      /^  - create_checkpoint:/m,
      "a promoted tool must leave the inventory on the same turn selection",
    );
  }
});

test("every deferred tool is reachable by both search phrasings", () => {
  // The live sweep in `scripts/verify-tool-discovery.mts` proves this one tool
  // at a time, against a real model, and only as far as the model chooses to
  // cooperate — a tool the model solves another way is reported UNMET and
  // proves nothing. This is the deterministic half: every name in the deferred
  // set, both routes, no model involved.
  //
  // `total_tools` is asserted alongside because it is the number the model is
  // told it can search; a catalog that counts a tool it will not return is the
  // inventory/wire disagreement this file exists to prevent.
  const deferred = Object.keys(toolRegistry).filter((name) => !CORE_TOOL_NAMES.has(name));
  assert.ok(deferred.length > 0, "there is a deferred set to test");

  for (const name of deferred) {
    const runId = `searchable-${name}`;
    clearDiscoveredTools(runId);

    // Route 1: the model knows the tool's name and asks for it outright.
    const selected = executeSearchTools(`select:${name}`, runId);
    assert.deepEqual(selected.discovered, [name], `select:${name} did not return exactly ${name}`);
    assert.ok(getDiscoveredTools(runId).has(name), `select:${name} must promote it`);

    // Route 2: the model describes the capability without knowing the name.
    // Searching a tool's own description is the floor — if the words the tool
    // uses to explain itself cannot rank it, no phrasing will.
    const description = toolRegistry[name as keyof typeof toolRegistry].description;
    const runIdKeyword = `searchable-keyword-${name}`;
    clearDiscoveredTools(runIdKeyword);
    const keyword = executeSearchTools(description, runIdKeyword);
    assert.ok(
      keyword.discovered.includes(name),
      `searching "${description}" did not surface \`${name}\`; it returned ${JSON.stringify(keyword.discovered)}`,
    );
  }
});

test("every deferred tool can be promoted onto a build-like wire", () => {
  // The narrowing must be a reorder, not a filter. Running the whole deferred
  // set through it catches the general case rather than the one tool that was
  // observed failing.
  const buildRequest = {
    payload: { prompt: "Build a production-style app with packages and tests." },
  };
  const runId = "every-deferred-on-build-wire";
  clearDiscoveredTools(runId);

  const deferred = Object.keys(toolRegistry).filter((name) => !CORE_TOOL_NAMES.has(name));
  for (const name of deferred) {
    discoverTools([name], runId);
  }

  const selected = new Set(
    selectGeneralAgentToolsForTurn({
      request: buildRequest as never,
      state: { toolResults: [] } as never,
      tools: buildGeneralAgentTools(getDiscoveredTools(runId)),
    }).map((tool) => tool.name),
  );

  for (const name of deferred) {
    assert.ok(selected.has(name), `${name} was promoted but narrowed off a build-like wire`);
  }
  // Core tools survive too — the narrowing's original and still-correct job.
  for (const name of CORE_TOOL_NAMES) {
    assert.ok(selected.has(name), `${name} is core and must always be on the wire`);
  }
});

test("the inventory stays bounded as the deferred set grows", () => {
  /*
   * The inventory is in the system prompt on every turn and each line costs
   * roughly 35 tokens, so an unbounded list is an unbounded standing cost.
   * Extensions register into the same registry, so the count is not bounded by
   * Reaper's own catalogue and cannot be reasoned about as if it were.
   *
   * Two properties, and the second is the one that is easy to get wrong:
   *
   *   1. The block stops growing past the cap. Asserted by adding fake tools to
   *      the registry and watching the length plateau.
   *   2. The truncation *says so*. A shortened list that reads as complete is
   *      worse than the long one it replaced — the model checks it, does not
   *      find what it wanted, and concludes the capability does not exist.
   */
  const runId = "inventory-bounded";
  clearDiscoveredTools(runId);
  const before = renderAvailableTools(runId);
  const baselineLength = before.length;

  // Simulate an extension-heavy install: a hundred extra deferred tools.
  const registry = toolRegistry as Record<string, { description: string; argsSchema: unknown; inputSchema?: unknown }>;
  const added: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const name = `zz_probe_tool_${i}`;
    if (name in registry) continue;
    registry[name] = {
      description: `A probe tool numbered ${i}, used to check that the inventory does not grow without limit.`,
      argsSchema: { parse: (value: unknown) => value },
    };
    added.push(name);
  }

  try {
    const after = renderAvailableTools(runId);
    assert.ok(
      after.length < baselineLength + 4_000,
      `the inventory grew by ${after.length - baselineLength} chars for 100 tools`,
    );

    // The elision is stated, and points at both ways to search.
    const renderedNames = (after.match(/^  - /gm) ?? []).length;
    assert.ok(renderedNames <= 24, `${renderedNames} tool lines rendered past the cap`);
    assert.match(after, /and \d+ more\./);
    assert.match(after, /search_tools/);
    assert.match(after, /select:<name>/);
  } finally {
    for (const name of added) delete registry[name];
  }
});
