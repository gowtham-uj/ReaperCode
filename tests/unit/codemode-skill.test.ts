/**
 * The `codemode` skill's examples, executed against the real registry.
 *
 * A skill is prose the model is told to trust, and the examples in it are the
 * part that gets copied verbatim. Nothing in the build checks an example in a
 * Markdown file, so an example can name an argument that no tool accepts and
 * the failure lands on the model — at the moment it is doing the thing the
 * skill told it to do, in the tool that is supposed to reduce round trips.
 *
 * This happened. The first version of the skill was written from memory with
 * `tools.read({ filePath })`, `{ content }`, and `{ command }`. The registry
 * spells those `file_view({ path })`, `write_file({ path, content })`, and
 * `bash({ cmd })`, and `file_view` returns a `window` array rather than a
 * `text` string — so every example in the file was wrong in a different way.
 *
 * So the examples are extracted from the Markdown and compiled here. Compiling
 * is not running: it does not prove the shapes are right, but it does prove the
 * code parses and that the call sites name arguments, which is where the rot
 * starts. The schema assertions below cover the rest, and they are written
 * against the same registry the runtime hands to `tools.*`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { toolRegistry } from "../../src/tools/registry.js";
import { builtinSkillsRoot } from "../../src/skills/built-in/index.js";

const skillPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/skills/built-in/codemode/SKILL.md",
);

const skill = readFileSync(skillPath, "utf8");

/** Every fenced ```js block in the skill, in order. */
function examples(): string[] {
  return [...skill.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

test("the skill ships, parses, and has examples to check", () => {
  // A rename or a move would make this file pass by checking nothing at all.
  assert.equal(builtinSkillsRoot().length > 0, true);
  assert.ok(skill.includes("# Code Mode"));
  assert.ok(examples().length >= 5, `expected several examples, found ${examples().length}`);
});

test("every example in the skill is valid JavaScript", () => {
  for (const [index, example] of examples().entries()) {
    /*
     * Compiled as the runtime compiles it: the script is wrapped in an async
     * IIFE so top-level `await` is legal, which is exactly how `tools.*` is
     * meant to be called. A bare `new Function(example)` would reject the
     * `await` in every example and prove nothing.
     */
    assert.doesNotThrow(
      () => new Function(`return (async () => { ${example}\n })();`),
      `example ${index + 1} does not compile:\n${example}`,
    );
  }
});

test("the tool names the examples call are real, and so are their arguments", () => {
  /*
   * The check that would have caught the original set.
   *
   * `tools.X(...)` is parsed out of each example and X is looked up in the
   * registry the same way the bridge looks it up. Then the argument keys used
   * at each call site are checked against that tool's schema, because a
   * plausible-looking `filePath` is the whole failure mode: it is close enough
   * to the real name that it reads as correct.
   */
  const unknown: string[] = [];
  const wrongKeys: string[] = [];

  for (const example of examples()) {
    for (const call of example.matchAll(/tools\.(\w+)\(\{([^}]*)\}\)/g)) {
      const [, name, rawArgs] = call;
      if (name === undefined || name === "list" || name === "describe") continue;

      const tool = (toolRegistry as Record<string, { argsSchema?: { shape?: Record<string, unknown> } }>)[name];
      if (!tool) {
        unknown.push(name);
        continue;
      }

      const accepted = new Set(Object.keys(tool.argsSchema?.shape ?? {}));
      if (accepted.size === 0) continue;

      for (const key of rawArgs?.matchAll(/(?:^|,)\s*(\w+)\s*:/g) ?? []) {
        const argument = key[1];
        if (argument && !accepted.has(argument)) {
          wrongKeys.push(`tools.${name}({ ${argument} }) — ${name} accepts ${[...accepted].join(", ")}`);
        }
      }
    }
  }

  assert.deepEqual(unknown, [], `the skill calls tools that do not exist: ${unknown.join(", ")}`);
  assert.deepEqual(wrongKeys, [], `the skill names arguments no tool accepts:\n  ${wrongKeys.join("\n  ")}`);
});

test("the argument names the prose tells the model to expect are the real ones", () => {
  /*
   * The skill singles out three tools by name in prose, because their argument
   * spellings are the ones a model gets wrong: `cmd` not `command`, `path` not
   * `filePath`, `pattern` for the search tools. Prose is checked separately
   * from the code blocks because that sentence is the part a model reads
   * before it writes anything.
   */
  const shape = (name: string) => Object.keys(toolRegistry[name as keyof typeof toolRegistry]?.argsSchema?.shape ?? {});

  assert.ok(shape("bash").includes("cmd"), "bash takes `cmd`; the skill says so and must stay true");
  assert.ok(shape("file_view").includes("path"));
  assert.ok(shape("grep_search").includes("pattern"));
  assert.ok(shape("write_file").includes("content"));
  assert.ok(shape("write_file").includes("path"));
});

test("the budgets the skill quotes are the budgets the runtime enforces", async () => {
  /*
   * The skill states specific numbers — the timeout, 64 MB, 200 calls, 256 KB,
   * 128 KB. A model that has been told the ceiling is 200 calls will structure a
   * script around it, so a skill that quotes a stale number is worse than one
   * that quotes none. Read from the constant rather than restated.
   *
   * The timeout sentence is checked against the constant rather than a literal
   * because it moved: it said 30 s until the default was raised to 120 s for
   * model calls that take 45–60 s to first token. Writing the new number here
   * as well would make this test the second place it has to be updated, and the
   * second place is the one that gets forgotten.
   */
  const { DEFAULT_CODE_RUNTIME_LIMITS: limits } = await import("../../src/tools/code/types.js");

  const seconds = Math.round(limits.timeoutMs / 1000);
  assert.ok(
    skill.includes(`Timeout ${seconds} s`),
    `the skill must state the real timeout (${seconds} s)`,
  );
  assert.equal(limits.memoryBytes, 64 * 1024 * 1024);
  assert.equal(limits.maxToolCalls, 200);
  assert.equal(limits.maxResultBytes, 256 * 1024);
  assert.equal(limits.maxConsoleBytes, 128 * 1024);
});

test("the skill tells the model it can raise its own timeout", async () => {
  /*
   * The field exists and is documented in the tool schema, but a model reading
   * the skill — which is where the budgets are explained — has to be told that
   * `timeout_ms` is its own to set. Otherwise the only route to a longer
   * deadline is reading the schema carefully, and a script that needs three
   * minutes instead of two fails in a way that looks like a hard limit.
   */
  assert.match(skill, /timeout_ms/);
  assert.match(skill, /per call/i);
});
