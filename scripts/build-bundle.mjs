/**
 * Build the single-file `reaper` bundle.
 *
 * Produces `bin/reaper.mjs`, a self-contained ES module that inlines the
 * agent code and its on-disk resources (built-in skills, linter manifest).
 * It runs with `node bin/reaper.mjs` and needs no `node_modules` and no
 * `npm ci`/`tsc` — only a Node runtime, which the consumer provides. A
 * Docker image can `COPY bin/reaper.mjs` into a `node:22` image and run it.
 *
 * Pipeline:
 *   1. esbuild bundles `scripts/run-reaper.ts` to ESM. Optional native deps
 *      (playwright, nut-js, uiohook, screenshot-desktop) stay external so the
 *      core agent boots without them and they degrade gracefully when used.
 *   2. Built-in skills + linter manifest are injected as compile-time
 *      constants (`__REAPER_BUNDLED_SKILLS__`, `__REAPER_BUNDLED_LINTERS__`)
 *      that `src/util/bundled-assets.ts` reads at runtime.
 *
 * Usage: `npm run build:binary`  (or `node scripts/build-bundle.mjs`)
 */

import { readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_BUNDLE = path.join(ROOT, "bin", "reaper.mjs");

// Optional / native dependencies that must stay external so the bundle boots
// without them. Each is reached only from a lazy, guarded path.
const EXTERNAL = [
  "playwright",
  "playwright-core",
  "chromium-bidi",
  "uiohook-napi",
  "@nut-tree-fork/nut-js",
  "screenshot-desktop",
  "jimp",
];

function walk(dir, base = dir, acc = {}) {
  for (const ent of readdirSync(dir)) {
    const full = path.join(dir, ent);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, base, acc);
    } else {
      const rel = path.relative(base, full).split(path.sep).join("/");
      acc[rel] = readFileSync(full, "utf8");
    }
  }
  return acc;
}

/** Collect built-in skill data files (skip TypeScript source). */
function collectSkills() {
  const root = path.join(ROOT, "src", "skills", "built-in");
  const out = {};
  for (const [rel, content] of Object.entries(walk(root))) {
    if (rel.endsWith(".ts")) continue; // data is skill.json/SKILL.md
    out[rel] = content;
  }
  return out;
}

function main() {
  const skills = collectSkills();
  const linters = readFileSync(
    path.join(ROOT, "src", "tools", "viewer", "linters", "manifest.json"),
    "utf8",
  );

  console.log("[build-bundle] bundling scripts/run-reaper.ts -> bin/reaper.mjs");
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, "scripts", "run-reaper.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: OUT_BUNDLE,
    external: EXTERNAL,
    define: {
      // Injected as raw JS expressions: the skills map is an object literal,
      // the linter manifest a string literal. (JSON.stringify of a string is a
      // quoted JS string; of an object it is an object literal.)
      __REAPER_BUNDLED_SKILLS__: JSON.stringify(skills),
      __REAPER_BUNDLED_LINTERS__: JSON.stringify(linters),
    },
    banner: {
      js: [
        "#!/usr/bin/env node",
        // CJS dependencies bundled into ESM rely on `require`, `__filename`,
        // and `__dirname`, none of which exist in ESM scope. Shim them from
        // `import.meta.url` so builtins and CJS packages (tree-kill,
        // typescript) resolve at runtime.
        "import { createRequire as __reaperCreateRequire } from \"node:module\";",
        "import { fileURLToPath as __reaperFileURLToPath } from \"node:url\";",
        "import __reaperPath from \"node:path\";",
        "var require = __reaperCreateRequire(import.meta.url);",
        "var __filename = __reaperFileURLToPath(import.meta.url);",
        "var __dirname = __reaperPath.dirname(__filename);",
      ].join("\n"),
    },
    logLevel: "warning",
  });

  // The banner adds the shebang but not the executable bit; set it so the
  // bundle can be run directly via `./bin/reaper.mjs`.
  const { chmodSync } = require("node:fs");
  chmodSync(OUT_BUNDLE, 0o755);

  console.log("[build-bundle] done ->", path.relative(ROOT, OUT_BUNDLE));
}

main();
