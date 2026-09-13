import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeDiagnostics } from "../../src/tools/diagnostics.js";

/*
 * Diagnostics has to distinguish three outcomes that all used to look alike:
 * the code is clean, the code has problems, and the tool could not run. The
 * first two are answers; the third is the absence of one, and reporting it as
 * "clean" is the failure mode these tests exist to prevent.
 *
 * The test that lived here before wrote a *clean* file and asserted
 * `typeof result.ok === "boolean"`, with the comment "tsc may or may not
 * succeed depending on tsconfig, but should return results". That assertion is
 * true of every possible result, so it could not fail, and it passed for the
 * entire life of three real bugs: `npx tsc` resolving to an unrelated package
 * of the same name, diagnostics being read from stderr when tsc writes to
 * stdout, and ES5 default compiler options reporting errors in valid code.
 */

async function withWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reaper-diag-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

test("diagnostics reports a real type error instead of a clean file", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "broken.ts"), "export const x: number = 'definitely not a number';\n", "utf8");

    const result = await executeDiagnostics("broken.ts", root, "tsc");

    assert.equal(result.ok, false, "a file with a type error must not report ok");
    assert.ok(result.diagnostics.length > 0, "the type error must be reported");

    const joined = result.diagnostics.map((entry) => entry.message).join("\n");
    // TS2322 specifically: a compiler that failed to run, or a stub package,
    // would not produce it.
    assert.match(joined, /TS2322/, `expected a TS2322 diagnostic, got: ${joined}`);
    assert.equal(result.diagnostics[0]?.line, 1, "the diagnostic carries its source line");
  });
});

test("diagnostics does not report errors in valid modern TypeScript", async () => {
  // With no tsconfig, `tsc --noEmit <file>` defaults to ES5 and reports
  // "Property 'at' does not exist on type 'number[]'" and "Promise only refers
  // to a type" in code that is perfectly correct. Confidently dirty is as
  // wrong as confidently clean, and it sends the model to rewrite working code.
  await withWorkspace(async (root) => {
    await writeFile(
      path.join(root, "modern.ts"),
      [
        "export async function go(): Promise<number | undefined> {",
        "  const nums: number[] = [1, 2, 3];",
        "  await Promise.resolve();",
        "  return nums.at(-1);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await executeDiagnostics("modern.ts", root, "tsc");

    assert.deepEqual(
      result.diagnostics.filter((entry) => entry.severity === "error"),
      [],
      `valid modern code was reported as broken: ${JSON.stringify(result.diagnostics, null, 2)}`,
    );
    assert.equal(result.ok, true);
  });
});

test("diagnostics finds a compiler in a workspace with no dependencies", async () => {
  // The failure this pins: `npx tsc` with no local install downloads a
  // same-named package from the registry that is not TypeScript. It accepts
  // every flag, exits zero, prints nothing, and turns a file full of type
  // errors into a clean report — the worst possible answer, delivered
  // confidently. Resolution must come from disk, never from the network.
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "broken.ts"), "const n: number = 'nope';\nexport default n;\n", "utf8");

    // A fresh mkdtemp has no node_modules, which is the condition under test.
    const result = await executeDiagnostics("broken.ts", root, "tsc");

    assert.equal(result.unavailable, undefined, `expected a reachable compiler, got: ${result.unavailable}`);
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some((entry) => /TS2322/.test(entry.message)),
      `the type error must survive with no workspace install: ${JSON.stringify(result.diagnostics)}`,
    );
  });
});

test("diagnostics is not fooled by a shim named tsc on PATH", async () => {
  // The live condition. `npx tsc` consults PATH, and PATH is attacker- and
  // accident-controlled: a project can contain a `tsc` of its own. Resolution
  // must reach a real compiler on disk, so a dispatcher that succeeds while
  // printing nothing must not be able to mask a type error.
  await withWorkspace(async (root) => {
    const binDir = path.join(root, "fakebin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, "tsc"),
      "#!/bin/sh\n# accepts every flag, reports nothing, exits clean\nexit 0\n",
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    try {
      await writeFile(path.join(root, "broken.ts"), "export const x: number = 'nope';\n", "utf8");
      const result = await executeDiagnostics("broken.ts", root, "tsc");

      assert.equal(result.ok, false, "the shim must not be able to report a clean file");
      assert.ok(
        result.diagnostics.some((entry) => /TS\d+/.test(entry.message)),
        `expected a real diagnostic, got: ${JSON.stringify(result.diagnostics)}`,
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

test("diagnostics says so when the file does not exist", async () => {
  await withWorkspace(async (root) => {
    const result = await executeDiagnostics("missing.ts", root, "tsc");
    assert.equal(result.ok, false);
    assert.match(String(result.unavailable), /No such file/);
    assert.deepEqual(result.diagnostics, [], "a file that does not exist is not a code problem");
  });
});

test("diagnostics refuses a path outside the workspace", async () => {
  await withWorkspace(async (root) => {
    const result = await executeDiagnostics("../../etc/passwd", root, "tsc");
    assert.equal(result.ok, false);
    assert.match(String(result.unavailable), /escapes workspace root/);
  });
});

test("diagnostics reports eslint as unavailable rather than clean", async () => {
  // The old code returned `{ ok: true, diagnostics: [] }` for anything that
  // was not tsc, including eslint, without running eslint. "I did not check"
  // and "I checked and it is clean" must not be the same answer.
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "app.js"), "export const x = 1;\n", "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });

    const result = await executeDiagnostics("app.js", root, "eslint");
    assert.equal(result.kind, "eslint");
    assert.match(String(result.unavailable), /eslint is not installed/);
    assert.equal(result.ok, false);
  });
});

test("diagnostics with no applicable language is a no-op, not a failure", async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "notes.txt"), "hello\n", "utf8");
    const result = await executeDiagnostics("notes.txt", root, "auto");
    assert.equal(result.kind, "none");
    assert.equal(result.ok, true);
    assert.deepEqual(result.diagnostics, []);
  });
});

test("a project with a tsconfig is told what the check did and did not cover", async () => {
  // The project's compilerOptions are now read from its tsconfig, but file
  // resolution is single-file, so the result is close to `tsc -p` without
  // being identical. The model reads diagnostics and nothing else, so the
  // caveat has to be in them.
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await writeFile(path.join(root, "clean.ts"), "export const x: number = 42;\n", "utf8");

    const result = await executeDiagnostics("clean.ts", root, "tsc");
    assert.equal(result.ok, true);
    const joined = result.diagnostics.map((entry) => entry.message).join("\n");
    assert.match(joined, /compiler options from/, "the model must be told where the options came from");
    assert.match(joined, /file resolution is single-file/, "and what the check did not cover");
  });
});

test("a project's own tsconfig strictness is applied", async () => {
  // The other half of the previous test: the options are not merely described,
  // they are used. An implicit `any` is an error under `strict` and legal
  // without it, so this file is the discriminator.
  const implicitAny = "export function id(value) {\n  return value;\n}\n";

  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "loose.ts"), implicitAny, "utf8");
    const withoutConfig = await executeDiagnostics("loose.ts", root, "tsc");
    assert.equal(
      withoutConfig.ok,
      true,
      `standalone defaults are non-strict, so this must be clean: ${JSON.stringify(withoutConfig.diagnostics)}`,
    );
  });

  await withWorkspace(async (root) => {
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");
    await writeFile(path.join(root, "strict.ts"), implicitAny, "utf8");
    const withConfig = await executeDiagnostics("strict.ts", root, "tsc");
    assert.equal(withConfig.ok, false, "the project's strict mode must be honored");
    assert.ok(
      withConfig.diagnostics.some((entry) => /TS7006/.test(entry.message)),
      `expected TS7006 for the implicit any, got: ${JSON.stringify(withConfig.diagnostics)}`,
    );
  });
});
