import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { inspectProject, renderRepoInspectionForCockpit } from "../../src/runtime/repo-inspection.js";
import { parseRuntimeState } from "../../src/runtime/state.js";

const execFile = promisify(execFileCallback);

async function makeTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

test("inspectProject detects npm scripts, frameworks, configs, directories, and entrypoints", async () => {
  const root = await makeTempProject("reaper-repo-inspection-npm-");
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "tests"));
    await writeFile(path.join(root, "src", "index.ts"), "export const ready = true;\n", "utf8");
    await writeFile(path.join(root, "package-lock.json"), "{}", "utf8");
    await writeFile(path.join(root, "tsconfig.json"), "{}", "utf8");
    await writeFile(path.join(root, "vite.config.ts"), "export default {};\n", "utf8");
    await writeFile(path.join(root, "playwright.config.ts"), "export default {};\n", "utf8");
    await writeJson(path.join(root, "package.json"), {
      scripts: {
        test: "node --test",
        build: "tsc -p tsconfig.build.json",
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        dev: "vite",
        start: "node dist/index.js",
      },
      dependencies: {
        "@vitejs/plugin-react": "^1.0.0",
        express: "^5.0.0",
        react: "^19.0.0",
        vite: "^7.0.0",
      },
      devDependencies: {
        jest: "^30.0.0",
        playwright: "^1.0.0",
      },
      main: "dist/index.js",
      bin: {
        sample: "bin/sample.js",
      },
    });

    const inspection = await inspectProject(root);

    assert.deepEqual(inspection.packageManagers, ["npm"]);
    assert.deepEqual(inspection.languages, ["TypeScript", "JavaScript"]);
    assert.deepEqual(inspection.testCommands, ["npm test"]);
    assert.deepEqual(inspection.buildCommands, ["npm run build", "npm run typecheck"]);
    assert.deepEqual(inspection.lintCommands, ["npm run lint"]);
    assert.deepEqual(inspection.importantDirectories, ["src", "tests"]);
    assert.ok(inspection.frameworks.includes("React"));
    assert.ok(inspection.frameworks.includes("Vite"));
    assert.ok(inspection.frameworks.includes("Express"));
    assert.ok(inspection.frameworks.includes("Jest"));
    assert.ok(inspection.frameworks.includes("Playwright"));
    assert.ok(inspection.configFiles.includes("package.json"));
    assert.ok(inspection.configFiles.includes("package-lock.json"));
    assert.ok(inspection.configFiles.includes("tsconfig.json"));
    assert.ok(inspection.configFiles.includes("vite.config.ts"));
    assert.ok(inspection.configFiles.includes("playwright.config.ts"));
    assert.ok(inspection.entrypoints.includes("dist/index.js"));
    assert.ok(inspection.entrypoints.includes("sample: bin/sample.js"));
    assert.ok(inspection.entrypoints.includes("npm run dev"));
    assert.ok(inspection.entrypoints.includes("npm start"));
    assert.ok(inspection.entrypoints.includes("src/index.ts"));

    const rendered = renderRepoInspectionForCockpit(inspection);
    assert.match(rendered, /# Repository Inspection/);
    assert.match(rendered, /Package managers: npm/);
    assert.match(rendered, /Test commands: npm test/);
    assert.match(rendered, /Important directories: src, tests/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectProject honors pnpm package metadata for rendered script commands", async () => {
  const root = await makeTempProject("reaper-repo-inspection-pnpm-");
  try {
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeJson(path.join(root, "package.json"), {
      packageManager: "pnpm@9.0.0",
      scripts: {
        test: "vitest run",
        build: "vite build",
      },
      devDependencies: {
        vitest: "^3.0.0",
      },
    });

    const inspection = await inspectProject(root);

    assert.deepEqual(inspection.packageManagers, ["pnpm"]);
    assert.deepEqual(inspection.testCommands, ["pnpm test"]);
    assert.deepEqual(inspection.buildCommands, ["pnpm build"]);
    assert.ok(inspection.frameworks.includes("Vitest"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectProject reports git dirty status and workspace risks", async () => {
  const root = await makeTempProject("reaper-repo-inspection-git-");
  try {
    await execFile("git", ["init"], { cwd: root });
    await writeJson(path.join(root, "package.json"), {
      scripts: {
        build: "tsc",
      },
    });

    const inspection = await inspectProject(root, { largeRepoFileThreshold: 0 });

    assert.match(inspection.gitStatus, /\?\? package\.json/);
    assert.ok(inspection.risks.includes("No test command detected."));
    assert.ok(inspection.risks.includes("Workspace has uncommitted changes."));
    assert.ok(inspection.risks.some((risk) => risk.startsWith("Large repository detected")));
    assert.match(renderRepoInspectionForCockpit(inspection), /Risks: .*Workspace has uncommitted changes/);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) return;
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectProject reports missing package manager and test command risks", async () => {
  const root = await makeTempProject("reaper-repo-inspection-risks-");
  try {
    await writeFile(path.join(root, "README.md"), "# fixture\n", "utf8");

    const inspection = await inspectProject(root);

    assert.deepEqual(inspection.packageManagers, []);
    assert.ok(inspection.risks.includes("No package manager detected."));
    assert.ok(inspection.risks.includes("No test command detected."));
    assert.match(renderRepoInspectionForCockpit(inspection), /Package managers: none/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime state accepts optional repoInspection", () => {
  const state = parseRuntimeState({
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    logLevel: "info",
    safetyProfile: "allow_all",
    noticeVerbosity: "normal",
    sessionProtocolVersion: 1,
    userIntentSummary: "Inspect the repository",
    tokenBudget: {
      softCap: 200000,
      inputTokens: 0,
      outputTokens: 0,
    },
    epicState: {
      objectives: [],
    },
    feedback: [],
    negativeConstraints: [],
    repoInspection: {
      packageManagers: ["npm"],
      languages: ["TypeScript"],
      frameworks: ["Vite"],
      testCommands: ["npm test"],
      buildCommands: ["npm run build"],
      lintCommands: [],
      entrypoints: ["src/index.ts"],
      configFiles: ["package.json"],
      importantDirectories: ["src"],
      gitStatus: "clean",
      risks: [],
    },
  });

  assert.deepEqual(state.repoInspection?.packageManagers, ["npm"]);
});
