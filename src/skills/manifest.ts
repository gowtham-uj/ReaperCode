/**
 * parseSkillManifest / writeSkillManifest — strict JSON shape for
 * `skill.json`. This is the *declarative* surface; SKILL.md is parsed
 * separately by `parseSkillFromRaw` in src/adaptive/skill-author.ts.
 *
 * Reuse rule: this file does NOT re-implement YAML parsing. It only
 * deals with JSON. The SKILL.md side is owned by skill-author.ts.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  ALL_SKILL_CATEGORIES,
  DEFAULT_SKILL_MEMORY_POLICY,
  SEMVER_REGEX,
  SKILL_NAME_REGEX,
  SkillValidationError,
  type SkillManifest,
} from "./types.js";

/**
 * Parse `skill.json` from disk. Throws SkillValidationError on any
 * structural issue. The returned object is the in-memory manifest;
 * fields not present on disk are filled with safe defaults.
 */
export function parseSkillManifestFromFile(path: string): SkillManifest {
  if (!existsSync(path)) {
    throw new SkillValidationError("path", "ENOENT", `manifest not found at ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  return parseSkillManifest(raw);
}

/**
 * Parse a JSON string into a SkillManifest. Throws on any structural
 * issue. The returned manifest has `memoryPolicy` defaulted if absent.
 */
export function parseSkillManifest(raw: string): SkillManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SkillValidationError("json", "EPARSE", `skill.json is not valid JSON: ${(e as Error).message}`);
  }
  return normalizeSkillManifest(parsed);
}

/**
 * Take any JSON-parsed object and coerce it into a SkillManifest.
 * Performs all schema checks; throws SkillValidationError on the
 * first violation. This is the single source of truth for the
 * schema — `validateSkillManifest` calls through to it.
 */
export function normalizeSkillManifest(value: unknown): SkillManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillValidationError("root", "ETYPE", "skill.json must be a JSON object");
  }
  const o = value as Record<string, unknown>;
  // name
  if (typeof o.name !== "string" || !SKILL_NAME_REGEX.test(o.name)) {
    throw new SkillValidationError("name", "ESHAPE", `name must match ${SKILL_NAME_REGEX}`);
  }
  // version
  if (typeof o.version !== "string" || !SEMVER_REGEX.test(o.version)) {
    throw new SkillValidationError("version", "ESEMVER", `version must be semver (got ${String(o.version)})`);
  }
  // description
  if (typeof o.description !== "string" || o.description.length === 0) {
    throw new SkillValidationError("description", "EREQUIRED", "description is required");
  }
  if (o.description.length > 240) {
    throw new SkillValidationError("description", "ETOOLONG", "description must be ≤ 240 characters");
  }
  // category
  if (typeof o.category !== "string" || !ALL_SKILL_CATEGORIES.includes(o.category as never)) {
    throw new SkillValidationError(
      "category",
      "EUNKNOWN_CATEGORY",
      `category must be one of ${ALL_SKILL_CATEGORIES.join(", ")} (got ${String(o.category)})`,
    );
  }
  // whenToUse
  if (typeof o.whenToUse !== "string" || o.whenToUse.length === 0) {
    throw new SkillValidationError("whenToUse", "EREQUIRED", "whenToUse is required");
  }
  // trust
  const trust = o.trust;
  if (trust !== "builtin" && trust !== "user-trusted" && trust !== "project-untrusted" && trust !== "extension-inherited" && trust !== "draft") {
    throw new SkillValidationError("trust", "ETYPE", "trust must be one of builtin|user-trusted|project-untrusted|extension-inherited|draft");
  }
  // allowedTools
  const allowedTools = asStringArray(o.allowedTools, "allowedTools");
  if (allowedTools === undefined) {
    throw new SkillValidationError("allowedTools", "ETYPE", "allowedTools must be a string array");
  }
  // triggers
  const triggers = o.triggers !== undefined ? asStringArray(o.triggers, "triggers") : [];
  if (triggers === undefined) {
    throw new SkillValidationError("triggers", "ETYPE", "triggers must be a string array");
  }
  // pathPatterns
  const pathPatterns = o.pathPatterns !== undefined ? asStringArray(o.pathPatterns, "pathPatterns") : [];
  if (pathPatterns === undefined) {
    throw new SkillValidationError("pathPatterns", "ETYPE", "pathPatterns must be a string array");
  }
  // arguments
  let arguments_;
  if (o.arguments !== undefined) {
    if (!Array.isArray(o.arguments)) {
      throw new SkillValidationError("arguments", "ETYPE", "arguments must be an array");
    }
    arguments_ = [];
    for (const a of o.arguments) {
      if (!a || typeof a !== "object") {
        throw new SkillValidationError("arguments", "ESHAPE", "each argument must be an object");
      }
      const aa = a as Record<string, unknown>;
      if (typeof aa.name !== "string" || !SKILL_NAME_REGEX.test(aa.name)) {
        throw new SkillValidationError("arguments[].name", "ESHAPE", "argument name must match kebab-case shape");
      }
      if (typeof aa.description !== "string") {
        throw new SkillValidationError("arguments[].description", "ETYPE", "argument description is required");
      }
      arguments_.push({
        name: aa.name,
        description: aa.description,
        required: aa.required === true,
      });
    }
  }
  // examples/templates/tests/resources
  const examples = o.examples !== undefined ? asStringArray(o.examples, "examples") : [];
  if (examples === undefined) throw new SkillValidationError("examples", "ETYPE", "examples must be a string array");
  const templates = o.templates !== undefined ? asStringArray(o.templates, "templates") : [];
  if (templates === undefined) throw new SkillValidationError("templates", "ETYPE", "templates must be a string array");
  const tests = o.tests !== undefined ? asStringArray(o.tests, "tests") : [];
  if (tests === undefined) throw new SkillValidationError("tests", "ETYPE", "tests must be a string array");
  const resources = o.resources !== undefined ? asStringArray(o.resources, "resources") : [];
  if (resources === undefined) throw new SkillValidationError("resources", "ETYPE", "resources must be a string array");
  // validation
  let validation;
  if (o.validation !== undefined) {
    if (!o.validation || typeof o.validation !== "object") {
      throw new SkillValidationError("validation", "ETYPE", "validation must be an object");
    }
    const v = o.validation as { commands?: unknown };
    if (!Array.isArray(v.commands)) {
      throw new SkillValidationError("validation.commands", "ETYPE", "validation.commands must be an array");
    }
    validation = { commands: v.commands.map((c, i) => normalizeValidationCommand(c, i)) };
  }
  // memoryPolicy
  const memoryPolicy = o.memoryPolicy !== undefined
    ? normalizeMemoryPolicy(o.memoryPolicy)
    : DEFAULT_SKILL_MEMORY_POLICY;
  // minimumReaperVersion (optional semver)
  if (o.minimumReaperVersion !== undefined && (typeof o.minimumReaperVersion !== "string" || !SEMVER_REGEX.test(o.minimumReaperVersion))) {
    throw new SkillValidationError("minimumReaperVersion", "ESEMVER", "minimumReaperVersion must be semver");
  }

  const out: SkillManifest = {
    name: o.name,
    version: o.version,
    description: o.description,
    category: o.category as never,
    whenToUse: o.whenToUse,
    trust,
    allowedTools,
    memoryPolicy,
  };
  if (triggers && triggers.length > 0) out.triggers = triggers;
  if (pathPatterns && pathPatterns.length > 0) out.pathPatterns = pathPatterns;
  if (arguments_ !== undefined) out.arguments = arguments_;
  if (examples && examples.length > 0) out.examples = examples;
  if (templates && templates.length > 0) out.templates = templates;
  if (tests && tests.length > 0) out.tests = tests;
  if (resources && resources.length > 0) out.resources = resources;
  if (validation !== undefined) out.validation = validation;
  if (typeof o.author === "string") out.author = o.author;
  if (typeof o.license === "string") out.license = o.license;
  if (typeof o.minimumReaperVersion === "string") out.minimumReaperVersion = o.minimumReaperVersion;
  return out;
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") return undefined;
    out.push(v);
  }
  return out;
}

function normalizeValidationCommand(c: unknown, i: number): { id: string; command: string; cwd?: string } {
  if (!c || typeof c !== "object") {
    throw new SkillValidationError(`validation.commands[${i}]`, "ETYPE", "validation command must be an object");
  }
  const cc = c as Record<string, unknown>;
  if (typeof cc.id !== "string" || cc.id.length === 0) {
    throw new SkillValidationError(`validation.commands[${i}].id`, "EREQUIRED", "id is required");
  }
  if (typeof cc.command !== "string" || cc.command.length === 0) {
    throw new SkillValidationError(`validation.commands[${i}].command`, "EREQUIRED", "command is required");
  }
  const out: { id: string; command: string; cwd?: string } = { id: cc.id, command: cc.command };
  if (typeof cc.cwd === "string") out.cwd = cc.cwd;
  return out;
}

function normalizeMemoryPolicy(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new SkillValidationError("memoryPolicy", "ETYPE", "memoryPolicy must be an object");
  }
  const v = value as Record<string, unknown>;
  return {
    mayReadProjectMemory: v.mayReadProjectMemory === true,
    mayWriteProjectMemory: v.mayWriteProjectMemory === true,
    mayReadUserMemory: v.mayReadUserMemory === true,
    mayWriteUserMemory: v.mayWriteUserMemory === true,
  };
}

/**
 * Atomically write `manifest` to `<dir>/skill.json`. Returns the
 * sha256 of the written bytes for tracking in the registry.
 */
export function writeSkillManifest(manifest: SkillManifest, dir: string): { path: string; sha256: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "skill.json");
  const json = JSON.stringify(manifest, null, 2);
  writeFileSync(path, json);
  const sha256 = createHash("sha256").update(json).digest("hex");
  return { path, sha256 };
}

/**
 * Compute the sha256 of a manifest. Used to detect drift between
 * what was discovered and what the registry last saw.
 */
export function sha256OfManifest(manifest: SkillManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
