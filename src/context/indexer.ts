import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// `ignoredDirectories` — exact-name matches we always skip (cheap
// directory-name test before recursing).
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".reaper",
  "scratchpad",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "target", // rust
  ".venv-pdf-edit",
  ".venv-terminal-bench",
  ".pdf-edit-packages",
  "vendor",
  "__pycache__",
  "site-packages", // python venv lib
  ".opencode",
  ".vscode",
  ".idea",
]);

// `ignoredDirectoryPrefixes` — name prefixes we skip. Matches against
// `entry.name`. Use this for directory families that may carry a
// project-specific suffix (e.g. ".venv-pdf-edit", ".venv-terminal-bench",
// "my-venv").
const ignoredDirectoryPrefixes = [
  ".venv",
  "venv",
  "env",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
];

// `ignoredDirectoryContains` — substring matches against `entry.name`.
// Last-resort test; substring scans are cheap but checked only after
// the exact-set test fails.
const ignoredDirectoryContains = [
  "node_modules",
  ".egg-info",
  ".dist-info",
  ".tox",
];

// `maxTotalFiles` — hard cap. The indexer returns as soon as it
// collects this many entries. The actual code in /workspace has
// 464K+ files; we want a representative sample, not the entire
// monorepo snapshot. Trajectory + fingerprint stay stable for
// "did the code change?" questions as long as we cover the working
// tree.
const MAX_TOTAL_FILES = 8000;

// `MAX_INDEXED_FILE_BYTES` — skip individual files larger than this.
// Large files (SQLite WAL logs, mp4s, zips, agent trajectory dumps)
// don't contain useful source code; reading them just to confirm
// they exist wastes seconds and trips tree-sitter / regex paths.
// 4 MiB is well above any reasonable source file.
const MAX_INDEXED_FILE_BYTES = 4 * 1024 * 1024;

// `ignoredFileExtensions` — never read these. They are either
// binary, huge-by-nature, or otherwise not useful for source-code
// ranking. The list is checked once per file via `path.extname`.
const ignoredFileExtensions = new Set([
  // archives
  ".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar", ".iso", ".dmg",
  ".deb", ".rpm", ".snap", ".appimage", ".jar", ".war", ".whl", ".egg",
  // images / video / audio
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv", ".m4v",
  ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac",
  // documents
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  // fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  // native / compiled
  ".so", ".dll", ".dylib", ".o", ".a", ".lib", ".obj", ".class",
  ".exe", ".bin", ".wasm", ".pyc", ".pyo", ".elc",
  // databases / logs that bloat the index
  ".sqlite", ".sqlite3", ".db", ".ldb", ".sdb",
  // misc
  ".lock", ".pid", ".swp", ".swo", ".DS_Store",
]);

// Concurrency cap for parallel stat() / readdir() fan-out. Node's
// libuv pool is small (~4 by default) so we cap to avoid thread
// contention while still getting real parallelism.
const MAX_CONCURRENCY = 64;

export interface IndexedFile {
  path: string;
  relativePath: string;
  sizeBytes: number;
  modifiedMs: number;
}

export interface CodebaseIndex {
  workspaceRoot: string;
  fingerprint: string;
  files: IndexedFile[];
  fileTree: string[];
  alwaysInclude: IndexedFile[];
  truncated: boolean;
}

export async function buildCodebaseIndex(workspaceRoot: string): Promise<CodebaseIndex> {
  const collected = await walkFiles(workspaceRoot, workspaceRoot, 0, 10);
  const truncated = collected.length >= MAX_TOTAL_FILES;
  const sorted = collected
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    // If we hit the cap, slice down to the deterministic top-N.
    // The fingerprint is still based on what we collected.
    .slice(0, MAX_TOTAL_FILES);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(sorted.map((file) => [file.relativePath, file.sizeBytes, file.modifiedMs])))
    .digest("hex");

  return {
    workspaceRoot,
    fingerprint,
    files: sorted,
    fileTree: sorted.map((file) => file.relativePath),
    alwaysInclude: sorted.filter((file) => alwaysIncludeNames.has(path.basename(file.relativePath))),
    truncated,
  };
}

export async function readIndexedFile(file: IndexedFile): Promise<string> {
  try {
    return await readFile(file.path, "utf8");
  } catch (error) {
    console.warn(`[indexer] Failed to read indexed file ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

const alwaysIncludeNames = new Set([
  "README.md",
  "README",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "AGENTS.md",
  "REAPER.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
]);

function shouldSkipDirectory(name: string): boolean {
  if (ignoredDirectories.has(name)) return true;
  for (const prefix of ignoredDirectoryPrefixes) {
    if (name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}_`)) return true;
  }
  for (const needle of ignoredDirectoryContains) {
    if (name.includes(needle)) return true;
  }
  return false;
}

async function walkFiles(root: string, currentDir: string, currentDepth: number, maxDepth: number): Promise<IndexedFile[]> {
  if (currentDepth > maxDepth) {
    return [];
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) return [];

  // Phase 1: classify and skip-in-place for directories that we know
  // are noise. We also collect the candidate file list (real files +
  // directories that still need recursion).
  const subdirs: Array<{ name: string; fullPath: string }> = [];
  const fileCandidates: Array<{ name: string; fullPath: string }> = [];
  let skippedLinks = 0;
  let skippedDirs = 0;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Skip symlinks entirely. Workspace trees often contain
      // symlinked virtualenvs (lib64 → lib), vcs shims, or shared
      // caches. Following them causes either deep recursion through
      // self-referential links (RangeError: Maximum call stack size
      // exceeded) or re-indexing the same files under a different
      // path. Files inside the link's target are reachable when the
      // user opens them directly via tool calls.
      skippedLinks += 1;
      continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name)) {
        skippedDirs += 1;
        continue;
      }
      subdirs.push({ name: entry.name, fullPath });
      continue;
    }
    if (entry.isFile()) {
      // Skip binary / archive files by extension. These don't
      // contribute to source-code context and bloat the index.
      const ext = path.extname(entry.name).toLowerCase();
      if (ignoredFileExtensions.has(ext)) {
        continue;
      }
      fileCandidates.push({ name: entry.name, fullPath });
      continue;
    }
    // Sockets, FIFOs, devices, etc. — skip silently.
  }

  // Phase 2: stat() the real files in bounded parallel batches. A
  // single 4.9 GB Python venv contains 30K+ files; serial stat() on
  // that takes minutes. With MAX_CONCURRENCY=64 we get real
  // parallelism without saturating libuv's pool.
  const results: IndexedFile[] = [];
  for (let i = 0; i < fileCandidates.length; i += MAX_CONCURRENCY) {
    const batch = fileCandidates.slice(i, i + MAX_CONCURRENCY);
    const batchStats = await Promise.all(
      batch.map(async ({ name, fullPath }) => {
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat || !fileStat.isFile()) return null;
        // Skip huge files — see MAX_INDEXED_FILE_BYTES above. These
        // bloat downstream consumers (the dependency graph reads
        // every indexed file, then tree-sitter parses each one).
        if (fileStat.size > MAX_INDEXED_FILE_BYTES) return null;
        return {
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          sizeBytes: fileStat.size,
          modifiedMs: Math.trunc(fileStat.mtimeMs),
        } satisfies IndexedFile;
      }),
    );
    for (const r of batchStats) {
      if (r) results.push(r);
    }
  }

  // Phase 3: recurse into subdirectories. We recurse in parallel too,
  // bounded by MAX_CONCURRENCY. If we hit MAX_TOTAL_FILES we bail out
  // early to keep the index build bounded.
  if (results.length < MAX_TOTAL_FILES && subdirs.length > 0) {
    const BATCH = Math.min(MAX_CONCURRENCY, subdirs.length);
    for (let i = 0; i < subdirs.length; i += BATCH) {
      const batch = subdirs.slice(i, i + BATCH);
      const subtrees = await Promise.all(
        batch.map((sd) => walkFiles(root, sd.fullPath, currentDepth + 1, maxDepth)),
      );
      for (const subtree of subtrees) {
        for (let j = 0; j < subtree.length; j++) {
          const file = subtree[j];
          if (!file) continue;
          results.push(file);
          if (results.length >= MAX_TOTAL_FILES) break;
        }
        if (results.length >= MAX_TOTAL_FILES) break;
      }
      if (results.length >= MAX_TOTAL_FILES) break;
    }
  }

  if (skippedLinks > 0 || skippedDirs > 0) {
    // Quiet note; not noise-worthy unless the user asks for verbose
    // indexing. Could route through a debug logger later.
  }

  return results;
}
