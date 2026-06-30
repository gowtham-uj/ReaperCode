import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths, ensureReaperScratchpad } from "../../workspace/scratchpad.js";
import { runShellCommandTool, isForegroundShellResult } from "../global/run-shell-command.js";

export async function inspectEnvironmentTool(workspaceRoot: string): Promise<Record<string, unknown>> {
  const scratchpad = await ensureReaperScratchpad(workspaceRoot);
  const packageManagers = await Promise.all([
    toolVersion(workspaceRoot, "node --version"),
    toolVersion(workspaceRoot, "npm --version"),
    toolVersion(workspaceRoot, "pnpm --version"),
    toolVersion(workspaceRoot, "yarn --version"),
    toolVersion(workspaceRoot, "python --version"),
    toolVersion(workspaceRoot, "pip --version"),
    toolVersion(workspaceRoot, "go version"),
    toolVersion(workspaceRoot, "cargo --version"),
  ]);

  const manifests = await findManifests(workspaceRoot);
  return {
    scratchpad,
    packageManagers: Object.fromEntries(packageManagers.map((item) => [item.name, item.version])),
    manifests,
    dependencyState: await dependencyState(workspaceRoot, manifests),
    recommendation:
      "Install task-required dependencies autonomously when manifests or missing-module/build errors show they are needed. Prefer the smallest maintained stack, avoid heavyweight scaffolds unless explicitly required, avoid vulnerable/deprecated versions, and use scratchpad cache env vars exposed to shell commands.",
  };
}

async function toolVersion(workspaceRoot: string, cmd: string): Promise<{ name: string; version: string | null }> {
  const name = cmd.split(" ")[0]!;
  try {
    const result = await runShellCommandTool(workspaceRoot, { cmd, timeoutMs: 10_000 }, "allow_all");
    if (!isForegroundShellResult(result)) {
      return { name, version: null };
    }
    const version = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
    return { name, version: version || null };
  } catch {
    return { name, version: null };
  }
}

async function findManifests(workspaceRoot: string): Promise<Array<{ path: string; kind: string }>> {
  const manifests: Array<{ path: string; kind: string }> = [];
  await walk(workspaceRoot, workspaceRoot, manifests, 0);
  return manifests.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root: string, dir: string, manifests: Array<{ path: string; kind: string }>, depth: number): Promise<void> {
  if (depth > 5) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".reaper", "scratchpad", "dist", "build", "coverage"].includes(entry.name)) continue;
      await walk(root, path.join(dir, entry.name), manifests, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const kind = manifestKind(entry.name);
    if (kind) manifests.push({ path: path.relative(root, path.join(dir, entry.name)), kind });
  }
}

function manifestKind(filename: string): string | undefined {
  if (filename === "package.json") return "node";
  if (["requirements.txt", "pyproject.toml", "Pipfile", "poetry.lock"].includes(filename)) return "python";
  if (filename === "go.mod") return "go";
  if (filename === "Cargo.toml") return "rust";
  return undefined;
}

async function dependencyState(workspaceRoot: string, manifests: Array<{ path: string; kind: string }>): Promise<Array<Record<string, unknown>>> {
  const states: Array<Record<string, unknown>> = [];
  for (const manifest of manifests) {
    const dir = path.dirname(path.join(workspaceRoot, manifest.path));
    if (manifest.kind === "node") {
      states.push({ manifest: manifest.path, kind: "node", nodeModules: await exists(path.join(dir, "node_modules")), lockfile: await firstExisting(dir, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) });
    } else if (manifest.kind === "python") {
      states.push({ manifest: manifest.path, kind: "python", virtualenv: await exists(path.join(dir, ".venv")) || await exists(path.join(workspaceRoot, ".venv")) });
    } else {
      states.push({ manifest: manifest.path, kind: manifest.kind });
    }
  }
  const scratch = getReaperScratchpadPaths(workspaceRoot);
  states.push({ scratchpadDependenciesDir: scratch.dependencies, scratchpadCacheDir: scratch.cache });
  return states;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    if (await exists(path.join(dir, name))) return name;
  }
  return null;
}
