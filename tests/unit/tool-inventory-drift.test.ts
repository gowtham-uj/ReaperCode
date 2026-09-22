/**
 * The committed tool inventory is the one the registry would write today.
 *
 * `tools.md` is read by a person deciding what to drop or pin, so a stale copy
 * is not a cosmetic problem: the committed file listed `browser_control` and
 * `skim_file` while the registry held `browser_use` and no `skim_file` at all,
 * which meant a reader was told about a tool that does not exist and not told
 * about the one that does. The file said 30 tools; there were 29.
 *
 * The reason it had gone stale is that nothing compared the two. A note in the
 * script asking the next person to regenerate is not a check, and the failure is
 * silent in exactly the direction that matters: a missing tool reads as "we do
 * not have that" and a retired one reads as "we do".
 *
 * So this renders the file the way the script does and compares it to what is
 * committed. It is the only check that closes the loop, because it fails on the
 * same input that produced the wrong file rather than on a symptom of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { DEFERRED_GROUPS, renderToolList } from "../../src/tools/tool-inventory.js";
import { CORE_TOOL_NAMES, toolRegistry } from "../../src/tools/registry.js";

const TOOLS_MD = new URL("../../tools.md", import.meta.url);

test("the committed tools.md is byte-for-byte what the registry renders", async () => {
  const committed = await readFile(TOOLS_MD, "utf8");
  const rendered = renderToolList();
  assert.equal(
    committed,
    rendered,
    "tools.md is stale. Regenerate it with `node --import=tsx scripts/emit-tool-list.mts`.",
  );
});

test("every registered tool is named in the committed inventory, and nothing else is", async () => {
  /*
   * The same fact stated the way a reader would check it, so a failure names the
   * tool rather than pointing at a diff of 20,000 characters of descriptions.
   * The byte comparison above is the strong check; this is the legible one.
   */
  const committed = await readFile(TOOLS_MD, "utf8");
  const named = new Set(
    [...committed.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1]!),
  );
  for (const name of Object.keys(toolRegistry)) {
    assert.ok(named.has(name), `tools.md does not list ${name}, so a reader cannot know it exists`);
  }
  for (const name of named) {
    assert.ok(
      name in toolRegistry,
      `tools.md lists ${name}, which is not in the registry; it names a tool that does not exist`,
    );
  }
});

test("the header counts and the section counts agree with the registry", async () => {
  const committed = await readFile(TOOLS_MD, "utf8");
  const total = Object.keys(toolRegistry).length;
  const core = Object.keys(toolRegistry).filter((name) => CORE_TOOL_NAMES.has(name)).length;
  const deferred = total - core;

  assert.match(committed, new RegExp(`^${total} tools are registered\\.`, "m"));
  assert.match(committed, new RegExp(`## Core[^\\n]*\\(${core}\\)`));
  assert.match(committed, new RegExp(`## Deferred[^\\n]*\\(${deferred}\\)`));
});

test("no deferred group names a tool that is not registered", () => {
  /*
   * The grouped view is the one hand-written part of the render, so it is the
   * one part that can name a tool that no longer exists. It is filtered against
   * the live registry at render time (a retired name shows as `(retired: ...)`
   * rather than disappearing), which means a wrong entry here is visible but not
   * fatal. This pins the other direction: every name in every group has to be a
   * real tool, because a group is an assertion that these tools belong together.
   */
  for (const { label, members } of DEFERRED_GROUPS) {
    for (const name of members) {
      assert.ok(
        name in toolRegistry,
        `the "${label}" group names ${name}, which is not in the registry`,
      );
    }
  }
});

test("browser_use is listed, and browser_control and skim_file are not", async () => {
  /*
   * The two names this file was written for, pinned by name so the specific
   * regression cannot come back silently even if the counts happen to line up
   * again through some other change.
   */
  const committed = await readFile(TOOLS_MD, "utf8");
  assert.match(committed, /^\| `browser_use` \|/m, "the browser tool must be listed under its real name");
  assert.doesNotMatch(committed, /`browser_control`/, "browser_control was renamed to browser_use and does not exist");
  assert.doesNotMatch(committed, /`skim_file`/, "skim_file is not in the registry");
});
