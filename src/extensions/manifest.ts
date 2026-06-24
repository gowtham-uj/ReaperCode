/**
 * parseExtensionManifest / writeExtensionManifest — strict JSON
 * shape for `extension.json`.
 *
 * Mirrors the skill manifest pattern: this is the *declarative*
 * surface; the entry (`main`) is loaded by `loader.ts` separately.
 *
 * The validator rejects:
 *   - unknown id shape
 *   - non-semver version or engines.reaper
 *   - duplicate tool names within a single extension
 *   - permissions outside the known set
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  EXTENSION_ID_REGEX,
  SEMVER_RANGE_REGEX,
  type ExtensionContributions,
  type ExtensionManifest,
  type ExtensionPermission,
  type ExtensionToolContribution,
  type ExtensionHookContribution,
  type HookEventName,
  ExtensionValidationError,
} from "./types.js";

const VALID_PERMISSIONS: readonly ExtensionPermission[] = [
  "tools:read_file", "tools:write_file", "tools:edit_file", "tools:delete_file",
  "tools:run_shell_command", "tools:network",
  "shell:low", "shell:medium", "shell:high",
  "memory:project:read", "memory:project:write",
  "memory:user:read", "memory:user:write",
  "session:read", "session:write",
];

const VALID_HOOK_EVENTS: readonly HookEventName[] = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop",
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PreSkillInvoke", "PostSkillInvoke", "SkillCreated", "SkillSelected",
  "MemoryCandidate", "MemoryWritten", "MemoryRejected",
  "VisualArtifactAdded", "VisualAnalysisCompleted",
  "PreCompact", "PostCompact", "FileChanged",
];

export function parseExtensionManifestFromFile(path: string): ExtensionManifest {
  if (!existsSync(path)) {
    throw new ExtensionValidationError("path", "ENOENT", `manifest not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return parseExtensionManifest(raw);
}

export function parseExtensionManifest(raw: string): ExtensionManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ExtensionValidationError("json", "EPARSE", `extension.json is not valid JSON: ${(e as Error).message}`);
  }
  return normalizeExtensionManifest(parsed);
}

export function normalizeExtensionManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExtensionValidationError("root", "ETYPE", "extension.json must be a JSON object");
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== "string" || !EXTENSION_ID_REGEX.test(o.id)) {
    throw new ExtensionValidationError("id", "ESHAPE", `id must match ${EXTENSION_ID_REGEX}`);
  }
  if (typeof o.version !== "string" || !/^\d+\.\d+\.\d+/.test(o.version)) {
    throw new ExtensionValidationError("version", "ESEMVER", `version must be semver (got ${String(o.version)})`);
  }
  if (typeof o.description !== "string" || o.description.length === 0) {
    throw new ExtensionValidationError("description", "EREQUIRED", "description is required");
  }
  if (typeof o.main !== "string" || o.main.length === 0) {
    throw new ExtensionValidationError("main", "EREQUIRED", "main entry is required");
  }
  // JS-only enforcement: extensions must declare a `.js` entry. The
  // path may be a literal file, a file without extension (auto-appended),
  // or a directory (resolved to <dir>/index.js). TypeScript files
  // are explicitly rejected.
  if (/\.ts$/i.test(o.main) || /\.tsx$/i.test(o.main)) {
    throw new ExtensionValidationError("main", "EREQUIRE_JS", `extensions are JavaScript-only (got "${o.main}"); rename to .js`);
  }
  // engines.reaper
  if (!o.engines || typeof o.engines !== "object") {
    throw new ExtensionValidationError("engines", "EREQUIRED", "engines.reaper is required");
  }
  const eng = o.engines as Record<string, unknown>;
  if (typeof eng.reaper !== "string" || !SEMVER_RANGE_REGEX.test(eng.reaper)) {
    throw new ExtensionValidationError("engines.reaper", "ESEMVER", `engines.reaper must be a semver range (got ${String(eng.reaper)})`);
  }
  // permissions
  if (!Array.isArray(o.permissions)) {
    throw new ExtensionValidationError("permissions", "ETYPE", "permissions must be an array");
  }
  const permissions: ExtensionPermission[] = [];
  for (const p of o.permissions) {
    if (typeof p !== "string" || !VALID_PERMISSIONS.includes(p as ExtensionPermission)) {
      throw new ExtensionValidationError("permissions[]", "EUNKNOWN", `unknown permission "${String(p)}"`);
    }
    permissions.push(p as ExtensionPermission);
  }
  // contributes
  const contributes: ExtensionContributions = {};
  if (o.contributes !== undefined) {
    if (!o.contributes || typeof o.contributes !== "object") {
      throw new ExtensionValidationError("contributes", "ETYPE", "contributes must be an object");
    }
    const c = o.contributes as Record<string, unknown>;
    if (c.tools !== undefined) contributes.tools = normalizeTools(c.tools);
    if (c.skills !== undefined) {
      if (!Array.isArray(c.skills)) throw new ExtensionValidationError("contributes.skills", "ETYPE", "must be an array");
      contributes.skills = c.skills.map((s, i) => normalizeSkillContribution(s, i));
    }
    if (c.slashCommands !== undefined) {
      if (!Array.isArray(c.slashCommands)) throw new ExtensionValidationError("contributes.slashCommands", "ETYPE", "must be an array");
      contributes.slashCommands = c.slashCommands.map((s, i) => normalizeSlashCommand(s, i));
    }
    if (c.hooks !== undefined) {
      if (!Array.isArray(c.hooks)) throw new ExtensionValidationError("contributes.hooks", "ETYPE", "must be an array");
      contributes.hooks = c.hooks.map((h, i) => normalizeHook(h, i));
    }
    if (c.panels !== undefined) {
      if (!Array.isArray(c.panels)) throw new ExtensionValidationError("contributes.panels", "ETYPE", "must be an array");
      contributes.panels = c.panels.map((p, i) => normalizePanel(p, i));
    }
    if (c.contextProviders !== undefined) {
      if (!Array.isArray(c.contextProviders)) throw new ExtensionValidationError("contributes.contextProviders", "ETYPE", "must be an array");
      contributes.contextProviders = c.contextProviders.map((p, i) => normalizeContextProvider(p, i));
    }
    if (c.modelProviders !== undefined) {
      if (!Array.isArray(c.modelProviders)) throw new ExtensionValidationError("contributes.modelProviders", "ETYPE", "must be an array");
      contributes.modelProviders = c.modelProviders.map((p, i) => normalizeModelProvider(p, i));
    }
    if (c.repoAnalyzers !== undefined) {
      if (!Array.isArray(c.repoAnalyzers)) throw new ExtensionValidationError("contributes.repoAnalyzers", "ETYPE", "must be an array");
      contributes.repoAnalyzers = c.repoAnalyzers.map((p, i) => normalizeRepoAnalyzer(p, i));
    }
    if (c.testRunners !== undefined) {
      if (!Array.isArray(c.testRunners)) throw new ExtensionValidationError("contributes.testRunners", "ETYPE", "must be an array");
      contributes.testRunners = c.testRunners.map((p, i) => normalizeTestRunner(p, i));
    }
    if (c.diffRenderers !== undefined) {
      if (!Array.isArray(c.diffRenderers)) throw new ExtensionValidationError("contributes.diffRenderers", "ETYPE", "must be an array");
      contributes.diffRenderers = c.diffRenderers.map((p, i) => normalizeDiffRenderer(p, i));
    }
  }

  const out: ExtensionManifest = {
    id: o.id,
    version: o.version,
    description: o.description,
    main: o.main,
    engines: { reaper: eng.reaper },
    permissions,
    contributes,
  };
  if (typeof o.minimumReaperVersion === "string") out.minimumReaperVersion = o.minimumReaperVersion;
  if (typeof o.author === "string") out.author = o.author;
  if (typeof o.license === "string") out.license = o.license;
  return out;
}

function normalizeTools(value: unknown): ExtensionToolContribution[] {
  if (!Array.isArray(value)) throw new ExtensionValidationError("contributes.tools", "ETYPE", "must be an array");
  const seen = new Set<string>();
  const out: ExtensionToolContribution[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.tools[${i}]`, "ETYPE", "must be an object");
    const t = v as Record<string, unknown>;
    if (typeof t.name !== "string" || !/^[a-z][a-z0-9_.]{0,63}$/.test(t.name)) {
      throw new ExtensionValidationError(`contributes.tools[${i}].name`, "ESHAPE", "name must match ^[a-z][a-z0-9_.]{0,63}$");
    }
    if (seen.has(t.name)) {
      throw new ExtensionValidationError(`contributes.tools[${i}].name`, "EDUP", `duplicate tool name "${t.name}"`);
    }
    seen.add(t.name);
    if (typeof t.description !== "string") throw new ExtensionValidationError(`contributes.tools[${i}].description`, "ETYPE", "description required");
    const out_t: ExtensionToolContribution = { name: t.name, description: t.description };
    if (t.schema && typeof t.schema === "object") out_t.schema = t.schema as Record<string, unknown>;
    out.push(out_t);
  }
  return out;
}

function normalizeSkillContribution(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.skills[${i}]`, "ETYPE", "must be an object");
  const s = v as Record<string, unknown>;
  if (typeof s.manifestPath !== "string") throw new ExtensionValidationError(`contributes.skills[${i}].manifestPath`, "ETYPE", "manifestPath required");
  return { manifestPath: s.manifestPath };
}

function normalizeSlashCommand(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.slashCommands[${i}]`, "ETYPE", "must be an object");
  const s = v as Record<string, unknown>;
  if (typeof s.name !== "string" || !/^\/[a-z][a-z0-9_-]{0,63}$/.test(s.name)) {
    throw new ExtensionValidationError(`contributes.slashCommands[${i}].name`, "ESHAPE", `name must match ^/[a-z][a-z0-9_-]{0,63}$`);
  }
  if (typeof s.description !== "string") throw new ExtensionValidationError(`contributes.slashCommands[${i}].description`, "ETYPE", "description required");
  return { name: s.name, description: s.description };
}

function normalizeHook(v: unknown, i: number): ExtensionHookContribution {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.hooks[${i}]`, "ETYPE", "must be an object");
  const h = v as Record<string, unknown>;
  if (typeof h.event !== "string" || !VALID_HOOK_EVENTS.includes(h.event as HookEventName)) {
    throw new ExtensionValidationError(`contributes.hooks[${i}].event`, "EUNKNOWN_EVENT", `unknown event "${String(h.event)}"`);
  }
  const out: ExtensionHookContribution = { event: h.event as HookEventName };
  if (typeof h.timeoutMs === "number" && h.timeoutMs > 0) out.timeoutMs = h.timeoutMs;
  return out;
}

function normalizePanel(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.panels[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.panels[${i}].name`, "ETYPE", "name required");
  if (typeof p.title !== "string") throw new ExtensionValidationError(`contributes.panels[${i}].title`, "ETYPE", "title required");
  return { name: p.name, title: p.title };
}

function normalizeContextProvider(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.contextProviders[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.contextProviders[${i}].name`, "ETYPE", "name required");
  if (p.scope !== "project" && p.scope !== "user") throw new ExtensionValidationError(`contributes.contextProviders[${i}].scope`, "ETYPE", `scope must be project|user`);
  return { name: p.name, scope: p.scope as "project" | "user" };
}

function normalizeModelProvider(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.modelProviders[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.modelProviders[${i}].name`, "ETYPE", "name required");
  return { name: p.name };
}

function normalizeRepoAnalyzer(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.repoAnalyzers[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.repoAnalyzers[${i}].name`, "ETYPE", "name required");
  return { name: p.name };
}

function normalizeTestRunner(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.testRunners[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.testRunners[${i}].name`, "ETYPE", "name required");
  if (typeof p.command !== "string") throw new ExtensionValidationError(`contributes.testRunners[${i}].command`, "ETYPE", "command required");
  return { name: p.name, command: p.command };
}

function normalizeDiffRenderer(v: unknown, i: number) {
  if (!v || typeof v !== "object") throw new ExtensionValidationError(`contributes.diffRenderers[${i}]`, "ETYPE", "must be an object");
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string") throw new ExtensionValidationError(`contributes.diffRenderers[${i}].name`, "ETYPE", "name required");
  return { name: p.name };
}

/**
 * Atomically write `manifest` to `<dir>/extension.json`. Returns
 * the sha256 of the written bytes.
 */
export function writeExtensionManifest(manifest: ExtensionManifest, dir: string): { path: string; sha256: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "extension.json");
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(path, json);
  const sha256 = createHash("sha256").update(json).digest("hex");
  return { path, sha256 };
}
