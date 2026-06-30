import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface RepoInspection {
  packageManagers: string[];
  languages: string[];
  frameworks: string[];
  testCommands: string[];
  buildCommands: string[];
  lintCommands: string[];
  entrypoints: string[];
  configFiles: string[];
  importantDirectories: string[];
  gitStatus: string;
  risks: string[];
}

export interface RepoInspectionOptions {
  largeRepoFileThreshold?: number;
}

type PackageJson = {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  main?: unknown;
  bin?: unknown;
};

const PACKAGE_MANAGER_FILES: Array<[file: string, manager: string]> = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
];

const SCRIPT_COMMANDS = ["test", "build", "lint", "typecheck", "dev", "start"] as const;
const IMPORTANT_DIRECTORIES = ["src", "app", "pages", "server", "client", "tests", "__tests__"];
const SKIPPED_COUNT_DIRECTORIES = new Set([".git", ".reaper", "node_modules", "dist", "build", "coverage"]);
const LARGE_REPO_FILE_THRESHOLD = 5000;

const CONFIG_FILE_PATTERNS = [
  /^package\.json$/,
  /^tsconfig(?:\.[^.]+)?\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^pnpm-lock\.yaml$/,
  /^yarn\.lock$/,
  /^bun\.lockb?$/,
  /^vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^next\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^vitest\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^jest\.config\.(?:js|mjs|cjs|ts|mts|cts|json)$/,
  /^playwright\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)$/,
  /^\.eslintrc(?:\.(?:js|cjs|json|yaml|yml))?$/,
  /^\.prettierrc(?:\.(?:js|cjs|json|yaml|yml))?$/,
];

export async function inspectProject(root: string, options: RepoInspectionOptions = {}): Promise<RepoInspection> {
  const workspaceRoot = path.resolve(root);
  const rootEntries = await readRootEntries(workspaceRoot);
  const rootNames = new Set(rootEntries.map((entry) => entry.name));
  const packageJson = await readPackageJson(workspaceRoot);
  const scripts = asStringRecord(packageJson?.scripts);
  const dependencyNames = collectDependencyNames(packageJson);
  const packageManagers = detectPackageManagers(rootNames, packageJson);
  const primaryPackageManager = packageManagers[0] ?? "npm";
  const configFiles = detectConfigFiles(rootEntries);
  const importantDirectories = detectImportantDirectories(rootEntries);
  const languages = await detectLanguages(workspaceRoot, rootEntries, rootNames);
  const frameworks = detectFrameworks(dependencyNames, rootNames, configFiles);
  const { testCommands, buildCommands, lintCommands, entrypointScripts } = detectScriptCommands(scripts, primaryPackageManager);
  const entrypoints = await detectEntrypoints(workspaceRoot, packageJson, entrypointScripts);
  const gitStatus = await readGitStatus(workspaceRoot);
  const fileCount = await countRepoFiles(workspaceRoot, options.largeRepoFileThreshold ?? LARGE_REPO_FILE_THRESHOLD);
  const risks = detectRisks({
    packageManagers,
    testCommands,
    gitStatus,
    fileCount,
    largeRepoFileThreshold: options.largeRepoFileThreshold ?? LARGE_REPO_FILE_THRESHOLD,
  });

  return {
    packageManagers,
    languages,
    frameworks,
    testCommands,
    buildCommands,
    lintCommands,
    entrypoints,
    configFiles,
    importantDirectories,
    gitStatus,
    risks,
  };
}

export function renderRepoInspectionForCockpit(inspection: RepoInspection): string {
  const lines = [
    "# Repository Inspection",
    `Package managers: ${renderList(inspection.packageManagers)}`,
    `Languages: ${renderList(inspection.languages)}`,
    `Frameworks: ${renderList(inspection.frameworks)}`,
    `Test commands: ${renderList(inspection.testCommands)}`,
    `Build commands: ${renderList(inspection.buildCommands)}`,
    `Lint commands: ${renderList(inspection.lintCommands)}`,
    `Entrypoints: ${renderList(inspection.entrypoints)}`,
    `Config files: ${renderList(inspection.configFiles)}`,
    `Important directories: ${renderList(inspection.importantDirectories)}`,
    `Git status: ${inspection.gitStatus}`,
    `Risks: ${renderList(inspection.risks)}`,
  ];

  return lines.join("\n");
}

async function readRootEntries(root: string) {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    return JSON.parse(raw) as PackageJson;
  } catch {
    return undefined;
  }
}

function detectPackageManagers(rootNames: Set<string>, packageJson: PackageJson | undefined): string[] {
  const managers = new Set<string>();
  const packageManager = typeof packageJson?.packageManager === "string" ? packageJson.packageManager : "";

  for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    if (packageManager.startsWith(`${manager}@`)) managers.add(manager);
  }
  for (const [file, manager] of PACKAGE_MANAGER_FILES) {
    if (rootNames.has(file)) managers.add(manager);
  }
  if (rootNames.has("package.json") && managers.size === 0) managers.add("npm");

  return ordered([...managers], ["npm", "pnpm", "yarn", "bun"]);
}

async function detectLanguages(root: string, rootEntries: Awaited<ReturnType<typeof readRootEntries>>, rootNames: Set<string>): Promise<string[]> {
  const languages = new Set<string>();
  if (rootNames.has("tsconfig.json")) languages.add("TypeScript");
  if (rootNames.has("package.json")) languages.add("JavaScript");

  const rootFiles = rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  addLanguagesFromFileNames(rootFiles, languages);

  for (const dirName of IMPORTANT_DIRECTORIES) {
    if (!rootNames.has(dirName)) continue;
    try {
      const names = (await readdir(path.join(root, dirName), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
      addLanguagesFromFileNames(names, languages);
    } catch {
      // Directory may disappear while inspection is running.
    }
  }

  return ordered([...languages], ["TypeScript", "JavaScript"]);
}

function addLanguagesFromFileNames(fileNames: string[], languages: Set<string>): void {
  if (fileNames.some((name) => /\.(?:ts|tsx|mts|cts)$/.test(name))) languages.add("TypeScript");
  if (fileNames.some((name) => /\.(?:js|jsx|mjs|cjs)$/.test(name))) languages.add("JavaScript");
}

function detectFrameworks(dependencyNames: Set<string>, rootNames: Set<string>, configFiles: string[]): string[] {
  const frameworks = new Set<string>();
  const hasConfig = (prefix: string) => configFiles.some((file) => file.startsWith(prefix));

  if (dependencyNames.has("react") || dependencyNames.has("react-dom")) frameworks.add("React");
  if (dependencyNames.has("vite") || dependencyNames.has("@vitejs/plugin-react") || hasConfig("vite.config.")) frameworks.add("Vite");
  if (dependencyNames.has("next") || hasConfig("next.config.")) frameworks.add("Next");
  if (dependencyNames.has("express")) frameworks.add("Express");
  if (dependencyNames.has("fastify")) frameworks.add("Fastify");
  if (dependencyNames.has("vitest") || hasConfig("vitest.config.")) frameworks.add("Vitest");
  if (dependencyNames.has("jest") || dependencyNames.has("ts-jest") || hasConfig("jest.config.")) frameworks.add("Jest");
  if (dependencyNames.has("playwright") || dependencyNames.has("@playwright/test") || hasConfig("playwright.config.")) frameworks.add("Playwright");
  if (rootNames.has("pages") || rootNames.has("app")) {
    if (dependencyNames.has("next")) frameworks.add("Next");
  }

  return ordered([...frameworks], ["React", "Vite", "Next", "Express", "Fastify", "Vitest", "Jest", "Playwright"]);
}

function detectConfigFiles(rootEntries: Awaited<ReturnType<typeof readRootEntries>>): string[] {
  return rootEntries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(name)))
    .sort();
}

function detectImportantDirectories(rootEntries: Awaited<ReturnType<typeof readRootEntries>>): string[] {
  const directoryNames = new Set(rootEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  return IMPORTANT_DIRECTORIES.filter((directory) => directoryNames.has(directory));
}

function detectScriptCommands(
  scripts: Record<string, string>,
  packageManager: string,
): { testCommands: string[]; buildCommands: string[]; lintCommands: string[]; entrypointScripts: string[] } {
  const commandFor = (script: (typeof SCRIPT_COMMANDS)[number]) => renderPackageScriptCommand(packageManager, script);
  const present = new Set(SCRIPT_COMMANDS.filter((script) => typeof scripts[script] === "string"));
  const testCommands = present.has("test") ? [commandFor("test")] : [];
  const buildCommands = ["build", "typecheck"].filter((script) => present.has(script as "build" | "typecheck")).map((script) => commandFor(script as "build" | "typecheck"));
  const lintCommands = present.has("lint") ? [commandFor("lint")] : [];
  const entrypointScripts = ["dev", "start"].filter((script) => present.has(script as "dev" | "start")).map((script) => commandFor(script as "dev" | "start"));

  return { testCommands, buildCommands, lintCommands, entrypointScripts };
}

function renderPackageScriptCommand(packageManager: string, script: (typeof SCRIPT_COMMANDS)[number]): string {
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  if (script === "test") return "npm test";
  if (script === "start") return "npm start";
  return `npm run ${script}`;
}

async function detectEntrypoints(root: string, packageJson: PackageJson | undefined, entrypointScripts: string[]): Promise<string[]> {
  const entrypoints = new Set<string>(entrypointScripts);

  if (typeof packageJson?.main === "string") entrypoints.add(packageJson.main);
  if (typeof packageJson?.bin === "string") entrypoints.add(packageJson.bin);
  if (packageJson?.bin && typeof packageJson.bin === "object" && !Array.isArray(packageJson.bin)) {
    for (const [name, value] of Object.entries(packageJson.bin)) {
      if (typeof value === "string") entrypoints.add(`${name}: ${value}`);
    }
  }

  for (const file of ["src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "server/index.ts", "server/index.js"]) {
    if (await fileExists(path.join(root, file))) entrypoints.add(file);
  }

  return [...entrypoints].sort();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function readGitStatus(root: string): Promise<string> {
  try {
    await execFile("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { timeout: 2000 });
    const { stdout } = await execFile("git", ["-C", root, "status", "--short"], { timeout: 3000 });
    const status = stdout.trim();
    return status.length ? status.split("\n").slice(0, 20).join("\n") : "clean";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("not a git repository") ? "not a git repository" : `unavailable: ${message.split("\n")[0] ?? "git status failed"}`;
  }
}

async function countRepoFiles(root: string, limit: number): Promise<number> {
  let count = 0;

  async function visit(directory: string): Promise<void> {
    if (count > limit) return;
    let entries: Awaited<ReturnType<typeof readRootEntries>>;
    try {
      entries = await readRootEntries(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count > limit) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_COUNT_DIRECTORIES.has(entry.name)) await visit(fullPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }

  await visit(root);
  return count;
}

function detectRisks(input: {
  packageManagers: string[];
  testCommands: string[];
  gitStatus: string;
  fileCount: number;
  largeRepoFileThreshold: number;
}): string[] {
  const risks: string[] = [];
  if (input.packageManagers.length === 0) risks.push("No package manager detected.");
  if (input.testCommands.length === 0) risks.push("No test command detected.");
  if (input.gitStatus !== "clean" && input.gitStatus !== "not a git repository" && !input.gitStatus.startsWith("unavailable:")) {
    risks.push("Workspace has uncommitted changes.");
  }
  if (input.fileCount > input.largeRepoFileThreshold) risks.push(`Large repository detected (${input.fileCount}+ files).`);
  return risks;
}

function collectDependencyNames(packageJson: PackageJson | undefined): Set<string> {
  return new Set([...Object.keys(asRecord(packageJson?.dependencies)), ...Object.keys(asRecord(packageJson?.devDependencies))]);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringRecord(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string") output[key] = item;
  }
  return output;
}

function ordered(values: string[], preferredOrder: string[]): string[] {
  const order = new Map(preferredOrder.map((value, index) => [value, index]));
  return [...values].sort((left, right) => (order.get(left) ?? 999) - (order.get(right) ?? 999) || left.localeCompare(right));
}

function renderList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
}
