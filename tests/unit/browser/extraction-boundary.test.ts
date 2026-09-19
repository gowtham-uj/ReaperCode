/**
 * The browser tool stays extractable.
 *
 * The plan is to lift `src/browser/` and `src/tools/browser/` out into an MCP
 * server, and the thing that makes that cheap is a dependency graph with exactly
 * two edges:
 *
 *   src/browser/        ->  src/tools/code/    (the sandbox the program runs in)
 *   src/tools/browser/  ->  src/browser/       (the thing it drives)
 *   src/tools/browser/  ->  src/tools/code/    (the program transform, shared with eval)
 *
 * The third edge was discovered by this check rather than designed: the tool
 * imports `transform.js` so a browser program is wrapped exactly as an eval body
 * is, and the flat version of this file never looked at a single-dot-dot
 * specifier. It is recorded now with its reason rather than left to be
 * rediscovered.
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

/**
 * Every relative import in every .ts file under a directory, recursively.
 *
 * Recursive rather than flat, and that is a correction: the flat version missed
 * everything in a subdirectory, which is exactly where a new module lands. The
 * browser layer grew `runtime/` and the check would have gone on reporting
 * "clean" while never having looked at it.
 *
 * Each entry carries the path the specifier resolves to, relative to `src/`, so
 * the rules below can be about which *module* is reached rather than about which
 * characters appear in the specifier.
 */
async function relativeImports(dir: URL, base: string): Promise<Array<{ file: string; specifier: string; resolved: string }>> {
  const out: Array<{ file: string; specifier: string; resolved: string }> = [];
  const walk = async (current: URL, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, current), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const source = await readFile(new URL(entry.name, current), "utf8");
      /*
       * Only real import statements. A doc comment mentions paths and a stricter
       * match would flag prose, which is how a check like this becomes noise nobody
       * reads.
       */
      for (const match of source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gm)) {
        const specifier = match[1]!;
        /*
         * The file's own directory relative to `src/`, which is the layer plus
         * however many subdirectories it sits below. Passing the layer rather
         * than starting empty is what makes `./x.js` from a top-level file
         * resolve to `src/browser/x` and not to `src/x`.
         */
        out.push({ file: `${prefix}${entry.name}`, specifier, resolved: resolveAgainst(`${base}/${prefix}`, specifier) });
      }
    }
  };
  await walk(dir, "");
  return out;
}

/**
 * Where a specifier lands, relative to `src/`.
 *
 * The directory the importing file sits in, `src/<layer>/`, walked up once per
 * leading `../` and then down through whatever follows. Returns "" for anything
 * that escapes `src/` entirely, which is not a case this repo has and not one the
 * rules below should guess about.
 */
function resolveAgainst(fileDir: string, specifier: string): string {
  // `src/` plus the file's own directory inside it, e.g. "browser/runtime/".
  let parts = `src/${fileDir}`.split("/").filter((part) => part.length > 0);
  let rest = specifier;
  while (rest.startsWith("../")) {
    parts.pop();
    rest = rest.slice(3);
  }
  if (rest.startsWith("./")) rest = rest.slice(2);
  const tail = rest.replace(/\.js$/, "").split("/").filter((part) => part.length > 0);
  return [...parts, ...tail].join("/");
}

test("src/browser depends only on src/tools/code", async () => {
  /*
   * Asserted on the *resolved* path rather than on the specifier's prefix.
   *
   * The prefix version assumed every file sits directly in `src/browser/`, so
   * `../downloads.js` from a file in `src/browser/runtime/` looked like a step
   * out of the layer when it is a step within it. Resolving first makes the rule
   * what it says: which module is reached.
   */
  const imports = await relativeImports(BROWSER, "browser");
  const outside = imports.filter((entry) => entry.resolved.length > 0 && !entry.resolved.startsWith("src/browser/"));
  const unexpected = outside.filter((entry) => !entry.resolved.startsWith("src/tools/code/"));
  assert.deepEqual(
    unexpected,
    [],
    `src/browser must reach nothing but src/tools/code: ${unexpected.map((e) => `${e.file} -> ${e.specifier}`).join(", ")}`,
  );
  // The one dependency is real and expected, so it is asserted rather than left
  // unmentioned: if it disappears, the sandbox moved and the README is stale.
  assert.ok(
    outside.some((entry) => entry.resolved.startsWith("src/tools/code/")),
    "the sandbox dependency is the one edge this module is allowed, and it should still exist",
  );
});

test("src/tools/browser reaches src/browser, and the program transform, and nothing else", async () => {
  /*
   * Two allowed edges, not one.
   *
   * The header above names one, and the flat version of this check only ever
   * looked at `../../` specifiers, so it never saw the other: the tool imports
   * `../code/transform.js` to compile the model's program with the same wrapper
   * `eval` uses. That edge is real, deliberate, and older than this check.
   *
   * Recursing into the resolve step surfaced it, which is the point of doing the
   * check properly. The wrong responses were to loosen the rule until the import
   * passed and to leave the rule as written and now failing; the right one is to
   * state the graph as it is, with a reason for each edge, so the next import is
   * judged against a true baseline.
   */
  const allowed = ["src/browser/", "src/tools/code/"];
  const imports = await relativeImports(TOOL, "tools/browser");
  const outside = imports.filter((entry) => entry.resolved.length > 0 && !entry.resolved.startsWith("src/tools/browser/"));
  const unexpected = outside.filter((entry) => !allowed.some((prefix) => entry.resolved.startsWith(prefix)));
  assert.deepEqual(
    unexpected,
    [],
    `src/tools/browser must reach nothing but ${allowed.join(", ")}: ${unexpected.map((e) => `${e.file} -> ${e.specifier}`).join(", ")}`,
  );
  /*
   * Both edges are asserted to still exist, so this cannot silently become a
   * comment about a dependency that was removed.
   */
  assert.ok(outside.some((entry) => entry.resolved.startsWith("src/browser/")), "the browser edge is the tool's whole purpose");
  assert.ok(
    outside.some((entry) => entry.resolved.startsWith("src/tools/code/")),
    "the transform edge is shared with eval, so a program is compiled the same way in both",
  );
});

test("nothing in the browser layer reaches into core", async () => {
  /*
   * Named explicitly as well as covered above, because these are the layers that
   * would make an extraction expensive and the names are worth being able to
   * search for when someone is tempted.
   *
   * The check is against the *first* segment below `src/`, which is the layer,
   * rather than against the specifier as a string. That distinction is not
   * pedantry: the string version flagged `../../browser/runtime/control-extras.js`
   * as reaching into `runtime`, when it reaches into `browser` and the `runtime`
   * is a folder inside the browser layer. A rule that fires on the name of a
   * directory rather than on the dependency is a rule people learn to rename
   * around, and the next person to hit it would have moved a real edge out of
   * sight instead of out of the graph.
   */
  const forbidden = ["app-server", "config", "adaptive", "runtime", "skills", "logging", "model"];
  for (const [label, dir] of [["src/browser", BROWSER], ["src/tools/browser", TOOL]] as const) {
    const imports = await relativeImports(dir, label.replace("src/", ""));
    for (const entry of imports) {
      /*
       * Only relative specifiers. A bare `node:crypto` or a package name is not a
       * path into this repo, and resolving one produces a nonsense layer that
       * this check would then report as a violation.
       */
      if (!entry.specifier.startsWith(".")) continue;
      if (entry.resolved.length === 0) continue;
      const layer = entry.resolved.split("/")[1];
      assert.ok(
        layer === undefined || !forbidden.includes(layer),
        `${label}/${entry.file} imports ${entry.specifier}, which resolves to src/${entry.resolved} and reaches into ${layer}`,
      );
    }
  }
});

test("the resolver lands where the path actually goes", () => {
  /*
   * The rule is only as good as this function, and a resolver that silently
   * returned "" for everything would make the check above pass on every import.
   * These are the three shapes the two layers use.
   */
  assert.equal(resolveAgainst("tools/browser/", "../../browser/runtime/kit.js"), "src/browser/runtime/kit");
  assert.equal(resolveAgainst("browser/runtime/", "../downloads.js"), "src/browser/downloads");
  assert.equal(resolveAgainst("browser/", "../tools/code/guard.js"), "src/tools/code/guard");
  // The layer is the first segment below `src/`: `runtime` here is inside the
  // browser layer and must not be mistaken for the core one.
  assert.equal(resolveAgainst("tools/browser/", "../../browser/runtime/kit.js").split("/")[1], "browser");
  // And the core layer, reached the way a coupling would actually be written.
  assert.equal(resolveAgainst("browser/", "../runtime/engine.js").split("/")[1], "runtime");
});
