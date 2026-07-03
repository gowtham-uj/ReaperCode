import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { buildCodebaseIndex } from "../../src/context/indexer.js";
import { buildDependencyGraph } from "../../src/context/graph.js";
import { rankFilesByStructureAndLexical } from "../../src/context/ranking.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

async function createGraphWorkspace() {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, "src", "utils"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "src", "utils", "math.ts"),
    "export function add(a: number, b: number) { return a + b; }\nexport const PI = 3.14;\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "src", "feature.ts"),
    "import { add, PI } from './utils/math';\nexport function calc() { return add(PI, 1); }\n",
    "utf8",
  );

  const largeLines = Array.from({ length: 550 }, (_, index) => `export const line_${index} = ${index};`).join("\n") + "\n";
  await writeFile(path.join(workspaceRoot, "src", "large.ts"), largeLines, "utf8");
  return workspaceRoot;
}

function createExecutor(workspaceRoot: string) {
  return new ToolExecutor({
    workspaceRoot,
    runId: "run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

test("tree-sitter extraction finds symbols and imports for TypeScript files", async () => {
  const workspaceRoot = await createGraphWorkspace();
  const index = await buildCodebaseIndex(workspaceRoot);
  const graph = await buildDependencyGraph(index);

  const math = graph.nodes.get("src/utils/math.ts");
  const feature = graph.nodes.get("src/feature.ts");

  assert.ok(math);
  assert.ok(feature);
  assert.ok(math?.symbols.some((symbol) => symbol.name === "add"));
  assert.ok(feature?.imports.some((entry) => entry.includes("src/utils/math")));
  assert.equal(feature?.source, "tree-sitter");
});

test("replace_symbol updates a parsed symbol safely", async () => {
  const workspaceRoot = await createGraphWorkspace();
  const executor = createExecutor(workspaceRoot);

  const result = await executor.execute({
    id: "1",
    name: "replace_symbol",
    args: {
      path: "src/utils/math.ts",
      symbolName: "add",
      newCode: "export function add(a: number, b: number) { return a + b + 10; }",
    },
  });

  assert.equal(result.ok, true);
  const file = await readFile(path.join(workspaceRoot, "src", "utils", "math.ts"), "utf8");
  assert.match(file, /a \+ b \+ 10/);
});

test("large-file safe edit guard is removed — replace_in_file succeeds without pre-reading", async () => {
  const workspaceRoot = await createGraphWorkspace();
  const executor = createExecutor(workspaceRoot);

  // With the safe-edit guard removed, editing a large file without reading first should SUCCEED.
  const result = await executor.execute({
    id: "1",
    name: "replace_in_file",
    args: {
      path: "src/large.ts",
      oldString: "export const line_10 = 10;",
      newString: "export const line_10 = 999;",
    },
  });

  assert.equal(result.ok, true, "replace_in_file should succeed without pre-reading (guard removed)");
});

test("dependency ranking uses structure and lexical relevance", async () => {
  const workspaceRoot = await createGraphWorkspace();
  const index = await buildCodebaseIndex(workspaceRoot);
  const graph = await buildDependencyGraph(index);
  const ranking = rankFilesByStructureAndLexical("update add math feature", graph);

  assert.equal(ranking[0]?.path, "src/utils/math.ts");
  assert.ok(ranking.some((entry) => entry.path === "src/feature.ts"));
});

test("index updates reflect changed files on rebuild", async () => {
  const workspaceRoot = await createGraphWorkspace();
  const first = await buildCodebaseIndex(workspaceRoot);
  await writeFile(path.join(workspaceRoot, "src", "feature.ts"), "export function calc() { return 42; }\n", "utf8");
  const second = await buildCodebaseIndex(workspaceRoot);

  assert.notEqual(first.fingerprint, second.fingerprint);
  const secondGraph = await buildDependencyGraph(second);
  assert.ok(secondGraph.nodes.get("src/feature.ts")?.symbols.some((symbol) => symbol.name === "calc"));
});
