/**
 * The browser tool stays extractable.
 *
 * The plan is to lift `src/browser/` and `src/tools/browser/` out into an MCP
 * server, and the thing that makes that cheap is a dependency graph with exactly
 * two edges:
 *
 *   src/browser/        ->  src/tools/code/    (the sandbox the program runs in)
 *   src/tools/browser/  ->  src/browser/       (the thing it drives)
 *
 * Nothing in either reaches into the app-server, the config loader, the model
 * layer, or the runtime. That is what makes the extraction two one-line changes
 * in the registry and the executor plus a directory move, rather than an
 * untangling.
 *
 * Nothing enforced it. A comment said what the rule was, and a comment is what
 * the previous module-drift bug in this area also relied on: `recover` and
 * `capabilities` were documented and never bound, because two lists said they
 * must agree and nothing checked. The same failure here would be a new `import`
 * that quietly couples the tool to core, discovered when the extraction starts.
 *
 * So this reads the files and asserts the edges. It is a text check rather than a
 * type-level one because the rule is about *which* modules may be imported, which
 * a type error cannot express.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const BROWSER = new URL("../../../src/browser/", import.meta.url);
const TOOL = new URL("../../../src/tools/browser/", import.meta.url);

/** Every relative import in every .ts file under a directory. */
async function relativeImports(dir: URL): Promise<Array<{ file: string; specifier: string }>> {
  const files = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
  const out: Array<{ file: string; specifier: string }> = [];
  for (const entry of files) {
    const source = await readFile(new URL(entry.name, dir), "utf8");
    /*
     * Only real import statements. A doc comment mentions paths and a stricter
     * match would flag prose, which is how a check like this becomes noise nobody
     * reads.
     */
    for (const match of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
      out.push({ file: entry.name, specifier: match[1]! });
    }
  }
  return out;
}

test("src/browser depends only on src/tools/code", async () => {
  const imports = await relativeImports(BROWSER);
  const outside = imports.filter((entry) => entry.specifier.startsWith(".."));
  const unexpected = outside.filter((entry) => !entry.specifier.startsWith("../tools/code/"));
  assert.deepEqual(
    unexpected,
    [],
    `src/browser must reach nothing but ../tools/code: ${unexpected.map((e) => `${e.file} -> ${e.specifier}`).join(", ")}`,
  );
  // The one dependency is real and expected, so it is asserted rather than left
  // unmentioned: if it disappears, the sandbox moved and the README is stale.
  assert.ok(
    outside.some((entry) => entry.specifier.startsWith("../tools/code/")),
    "the sandbox dependency is the one edge this module is allowed, and it should still exist",
  );
});

test("src/tools/browser depends only on src/browser", async () => {
  const imports = await relativeImports(TOOL);
  const outside = imports.filter((entry) => entry.specifier.startsWith("../../"));
  const unexpected = outside.filter((entry) => !entry.specifier.startsWith("../../browser/"));
  assert.deepEqual(
    unexpected,
    [],
    `src/tools/browser must reach nothing but ../../browser: ${unexpected.map((e) => `${e.file} -> ${e.specifier}`).join(", ")}`,
  );
});

test("nothing in the browser layer reaches into core", async () => {
  /*
   * Named explicitly as well as covered above, because these are the layers that
   * would make an extraction expensive and the names are worth being able to
   * search for when someone is tempted.
   */
  const forbidden = ["app-server", "config", "adaptive", "runtime", "skills", "logging", "model"];
  for (const [label, dir] of [["src/browser", BROWSER], ["src/tools/browser", TOOL]] as const) {
    const imports = await relativeImports(dir);
    for (const entry of imports) {
      if (!entry.specifier.startsWith("..")) continue;
      for (const name of forbidden) {
        assert.ok(
          !entry.specifier.includes(`/${name}/`),
          `${label}/${entry.file} imports ${entry.specifier}, which reaches into ${name}`,
        );
      }
    }
  }
});
