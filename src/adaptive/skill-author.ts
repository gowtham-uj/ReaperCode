/**
 * AdaptiveSkillAuthor — parse, validate, create, and manage Reaper
 * skills. The SKILL.md format (frontmatter + markdown body) is
 * extended here with scope, validation, and memory policy.
 *
 * Skill frontmatter format:
 *
 * ---
 * name: my-skill
 * description: One-line summary
 * type: prompt | workflow | checklist | tool-guide
 * scope: project | user | builtin
 * whenToUse: When to use
 * disableAutoInvocation: false
 * arguments: [a, b]
 * allowedTools: [view_file, run_tests]
 * validation: { commands: [{id, command, cwd?}] }
 * memoryPolicy: { mayReadProjectMemory: true, mayWriteProjectMemory: true, mayReadUserMemory: false, mayWriteUserMemory: false }
 * version: 1
 * createdBy: reaper
 * createdAt: 2026-01-01T00:00:00Z
 * updatedAt: 2026-01-01T00:00:00Z
 * ---
 *
 * # body
 *
 * Plain markdown body. May include `$ARGUMENTS`, `$0`, `$1`, `$<name>`,
 * `${REAPER_SKILL_DIR}` placeholders. Nesting depth is capped at 3.
 *
 * Skill priority (most specific first): project > user > builtin.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { randomUUID } from "node:crypto";

import type { ReaperSkill, SkillScope, SkillType, SkillValidationSpec, SkillMemoryPolicy, SkillReference } from "./types.js";

/* -------------------------------------------------------------------------- */
/*                              Frontmatter                                    */
/* -------------------------------------------------------------------------- */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return null;
  const yaml = m[1] ?? "";
  const body = (m[2] ?? "").trim();
  const fm = parseSimpleYaml(yaml);
  return { frontmatter: fm, body };
}

/**
 * Tiny YAML parser. Supports:
 *  - scalar: key: value
 *  - lists: `- item` (indented under key)
 *  - inline lists: key: [a, b, c]
 *  - inline objects: key: { k: v, k2: v2 }
 *  - boolean / number coercion
 *
 * Not a full YAML implementation. Skills are expected to be authored
 * by Reaper itself or by users following the documented format. We
 * intentionally reject exotic YAML.
 */
export function parseSimpleYaml(input: string): Record<string, unknown> {
  const lines = input.split(/\r?\n/);
  const root: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const indent = m[1]?.length ?? 0;
    const key = m[2]!;
    const rest = (m[3] ?? "").trim();
    if (rest === "" || rest === "|" || rest === ">") {
      // Possibly a list or nested map underneath
      const block: unknown[] = [];
      const obj: Record<string, unknown> = {};
      let isList = false;
      let isMap = false;
      j_loop: while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        if (!next.trim()) { i++; continue; }
        const nextIndent = (next.match(/^(\s*)/)?.[1] ?? "").length;
        if (nextIndent <= indent) break;
        if (/^\s*-\s/.test(next)) {
          isList = true;
          const item = next.replace(/^\s*-\s+/, "");
          if (item.includes(":")) {
            // list of objects -> not fully supported, fall back to string
            block.push(item);
          } else {
            block.push(coerceScalar(item));
          }
          i++;
        } else {
          isMap = true;
          const nm = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(next);
          if (!nm) break j_loop;
          obj[nm[2]!] = coerceScalar((nm[3] ?? "").trim());
          i++;
        }
      }
      root[key] = isList ? block : isMap ? obj : undefined;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      root[key] = inner;
    } else if (rest.startsWith("{") && rest.endsWith("}")) {
      try {
        // Use a safe minimal object parser
        const obj: Record<string, unknown> = {};
        const inner = rest.slice(1, -1).trim();
        if (inner) {
          for (const part of inner.split(",")) {
            const kv = part.split(":");
            if (kv.length < 2) continue;
            const k = kv[0]!.trim().replace(/^["']|["']$/g, "");
            const v = kv.slice(1).join(":").trim().replace(/^["']|["']$/g, "");
            obj[k] = coerceScalar(v);
          }
        }
        root[key] = obj;
      } catch { root[key] = rest; }
    } else {
      root[key] = coerceScalar(rest);
    }
    i++;
  }
  return root;
}

function coerceScalar(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (v === "") return "";
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/*                              Validation                                     */
/* -------------------------------------------------------------------------- */

const VALID_TYPES: SkillType[] = ["prompt", "workflow", "checklist", "tool-guide"];
const VALID_SCOPES: SkillScope[] = ["project", "user", "builtin"];

export interface SkillValidationError {
  field: string;
  message: string;
}

export function validateSkillFields(fm: Record<string, unknown>): { ok: true; normalized: Record<string, unknown> } | { ok: false; errors: SkillValidationError[] } {
  const errors: SkillValidationError[] = [];
  const name = fm.name;
  if (typeof name !== "string" || name.length === 0) errors.push({ field: "name", message: "name is required" });
  const description = fm.description;
  if (typeof description !== "string" || description.length === 0) errors.push({ field: "description", message: "description is required" });
  const type = (fm.type as SkillType | undefined) ?? "prompt";
  if (!VALID_TYPES.includes(type)) errors.push({ field: "type", message: `type must be one of ${VALID_TYPES.join(", ")}` });
  const scope = (fm.scope as SkillScope | undefined) ?? "project";
  if (!VALID_SCOPES.includes(scope)) errors.push({ field: "scope", message: `scope must be one of ${VALID_SCOPES.join(", ")}` });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, normalized: { ...fm, type, scope } };
}

/* -------------------------------------------------------------------------- */
/*                              Skill IO                                       */
/* -------------------------------------------------------------------------- */

export function skillDirName(workspaceRoot: string, scope: SkillScope, builtinRoot?: string): string {
  if (scope === "project") return join(workspaceRoot, ".reaper", "skills");
  if (scope === "user") return join(process.env.HOME ?? "~", ".reaper", "skills");
  if (scope === "builtin") return builtinRoot ?? join(workspaceRoot, ".reaper", "skills-builtin");
  throw new Error(`unknown scope ${scope}`);
}

export interface LoadSkillOptions {
  workspaceRoot: string;
  builtinRoot?: string;
  userHome?: string;
}

export function loadSkill(skillMdPath: string, scope: SkillScope): ReaperSkill | null {
  if (!existsSync(skillMdPath)) return null;
  const raw = readFileSync(skillMdPath, "utf8");
  return parseSkillFromRaw(raw, scope, skillMdPath);
}

export function parseSkillFromRaw(raw: string, scope: SkillScope, sourcePath: string): ReaperSkill | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const v = validateSkillFields(parsed.frontmatter);
  if (!v.ok) return null;
  const fm = v.normalized;
  const skillDir = dirname(sourcePath);
  const name = String(fm.name);
  const description = String(fm.description);
  const type = (fm.type as SkillType) ?? "prompt";
  const whenToUse = String(fm.whenToUse ?? "");
  // F2: canonical field is disableModelInvocation. The legacy
  // `disableAutoInvocation` frontmatter key still works.
  const disableModelInvocation = Boolean(
    fm.disableModelInvocation ?? fm.disableAutoInvocation,
  );
  const arguments_ = Array.isArray(fm.arguments) ? fm.arguments.map(String) : [];
  const allowedTools = Array.isArray(fm.allowedTools) ? fm.allowedTools.map(String) : [];
  const validation = parseValidation(fm.validation);
  const memoryPolicy = parseMemoryPolicy(fm.memoryPolicy);
  const refs = listReferences(skillDir);
  const version = parseInt(String(fm.version ?? "1"), 10);
  const createdBy = String(fm.createdBy ?? "reaper");
  const createdAt = String(fm.createdAt ?? new Date().toISOString());
  const updatedAt = String(fm.updatedAt ?? new Date().toISOString());

  return {
    name,
    description,
    type,
    scope,
    whenToUse,
    disableAutoInvocation: disableModelInvocation,
    disableModelInvocation,
    arguments: arguments_,
    allowedTools,
    ...(validation !== undefined ? { validation } : {}),
    memoryPolicy,
    body: parsed.body,
    references: refs,
    sourcePath,
    version,
    createdBy,
    createdAt,
    updatedAt,
    skillDir,
  };
}

function parseValidation(v: unknown): SkillValidationSpec | undefined {
  if (!v || typeof v !== "object") return undefined;
  const obj = v as { commands?: unknown };
  if (!Array.isArray(obj.commands)) return undefined;
  return {
    commands: obj.commands.map((c) => {
      const cc = c as { id?: unknown; command?: unknown; cwd?: unknown };
      return {
        id: String(cc.id ?? ""),
        command: String(cc.command ?? ""),
        ...(typeof cc.cwd === "string" ? { cwd: cc.cwd } : {}),
      };
    }),
  };
}

function parseMemoryPolicy(v: unknown): SkillMemoryPolicy {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    mayReadProjectMemory: Boolean(o.mayReadProjectMemory),
    mayWriteProjectMemory: Boolean(o.mayWriteProjectMemory),
    mayReadUserMemory: Boolean(o.mayReadUserMemory),
    mayWriteUserMemory: Boolean(o.mayWriteUserMemory),
  };
}

function listReferences(skillDir: string): SkillReference[] {
  const out: SkillReference[] = [];
  const candidates = ["references", "scripts", "assets"];
  for (const c of candidates) {
    const dir = join(skillDir, c);
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        let kind: SkillReference["kind"] = "text";
        if (/\.(png|jpg|jpeg|gif|webp|mp4|webm)$/i.test(name)) kind = "binary";
        else if (/\.(json|ya?ml|toml|csv)$/i.test(name)) kind = "data";
        else if (/\.(ts|js|py|sh|rs|go|java)$/i.test(name)) kind = "code";
        out.push({ name, path: p, kind });
      }
    } catch { /* ignore */ }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*                              Author                                          */
/* -------------------------------------------------------------------------- */

export interface CreateSkillInput {
  name: string;
  description: string;
  type?: SkillType;
  scope: SkillScope;
  whenToUse?: string;
  body: string;
  allowedTools?: string[];
  arguments?: string[];
  validation?: SkillValidationSpec;
  memoryPolicy?: Partial<SkillMemoryPolicy>;
  workspaceRoot: string;
  builtinRoot?: string;
  userHome?: string;
  createdBy?: string;
}

export function createSkill(input: CreateSkillInput): ReaperSkill {
  const dir = skillDirName(input.workspaceRoot, input.scope, input.builtinRoot);
  if (input.scope === "user" && input.userHome) {
    const homeDir = join(input.userHome, ".reaper", "skills");
    return createSkillAt(homeDir, input);
  }
  return createSkillAt(dir, input);
}

function createSkillAt(baseDir: string, input: CreateSkillInput): ReaperSkill {
  const skillDir = join(baseDir, input.name);
  mkdirSync(skillDir, { recursive: true });
  const now = new Date().toISOString();
  const skill: ReaperSkill = {
    name: input.name,
    description: input.description,
    type: input.type ?? "prompt",
    scope: input.scope,
    whenToUse: input.whenToUse ?? input.description,
    disableAutoInvocation: false,
    arguments: input.arguments ?? [],
    allowedTools: input.allowedTools ?? [],
    ...(input.validation !== undefined ? { validation: input.validation } : {}),
    memoryPolicy: {
      mayReadProjectMemory: input.memoryPolicy?.mayReadProjectMemory ?? true,
      mayWriteProjectMemory: input.memoryPolicy?.mayWriteProjectMemory ?? true,
      mayReadUserMemory: input.memoryPolicy?.mayReadUserMemory ?? false,
      mayWriteUserMemory: input.memoryPolicy?.mayWriteUserMemory ?? false,
    },
    body: input.body,
    references: [],
    sourcePath: join(skillDir, "SKILL.md"),
    version: 1,
    createdBy: input.createdBy ?? "reaper",
    createdAt: now,
    updatedAt: now,
    skillDir,
  };
  writeFileSync(skill.sourcePath, serializeSkill(skill));
  return skill;
}

export function serializeSkill(s: ReaperSkill): string {
  const fm: string[] = ["---"];
  fm.push(`name: ${s.name}`);
  fm.push(`description: ${s.description}`);
  fm.push(`type: ${s.type}`);
  fm.push(`scope: ${s.scope}`);
  if (s.whenToUse) fm.push(`whenToUse: ${s.whenToUse}`);
  fm.push(`disableAutoInvocation: ${s.disableAutoInvocation}`);
  if (s.arguments.length > 0) fm.push(`arguments: [${s.arguments.map((a) => a).join(", ")}]`);
  if (s.allowedTools.length > 0) fm.push(`allowedTools: [${s.allowedTools.join(", ")}]`);
  if (s.validation) {
    fm.push("validation:");
    fm.push("  commands:");
    for (const c of s.validation.commands) {
      fm.push(`    - id: ${c.id}`);
      fm.push(`      command: ${c.command}`);
      if (c.cwd) fm.push(`      cwd: ${c.cwd}`);
    }
  }
  fm.push("memoryPolicy:");
  fm.push(`  mayReadProjectMemory: ${s.memoryPolicy.mayReadProjectMemory}`);
  fm.push(`  mayWriteProjectMemory: ${s.memoryPolicy.mayWriteProjectMemory}`);
  fm.push(`  mayReadUserMemory: ${s.memoryPolicy.mayReadUserMemory}`);
  fm.push(`  mayWriteUserMemory: ${s.memoryPolicy.mayWriteUserMemory}`);
  fm.push(`version: ${s.version}`);
  fm.push(`createdBy: ${s.createdBy}`);
  fm.push(`createdAt: ${s.createdAt}`);
  fm.push(`updatedAt: ${s.updatedAt}`);
  fm.push("---");
  fm.push("");
  fm.push(s.body);
  return fm.join("\n");
}

export function disableSkill(workspaceRoot: string, name: string, scope: SkillScope, builtinRoot?: string, userHome?: string, reason?: string): boolean {
  // Resolve target path directly without calling skillDirName with the
  // awkward empty-string sentinel — pick the right base by scope.
  const baseDir = scope === "user" && userHome
    ? join(userHome, ".reaper", "skills")
    : scope === "builtin" && builtinRoot
      ? builtinRoot
      : join(workspaceRoot, ".reaper", "skills");
  const target = join(baseDir, name, "SKILL.md");
  if (!existsSync(target)) return false;
  const raw = readFileSync(target, "utf8");
  // Insert a `disabled: true` line into the frontmatter
  const updated = raw.replace(/^---/, "---").replace(/^(---\n)/, `$1disabled: true\ndisableAutoInvocation: true\n# disabled: ${reason ?? "no reason"}\n`);
  writeFileSync(target, updated);
  return true;
}

export function deleteSkill(workspaceRoot: string, name: string, scope: SkillScope, builtinRoot?: string, userHome?: string): boolean {
  let target: string;
  if (scope === "user" && userHome) target = join(userHome, ".reaper", "skills", name);
  else if (scope === "builtin" && builtinRoot) target = join(builtinRoot, name);
  else target = join(workspaceRoot, ".reaper", "skills", name);
  if (!existsSync(target)) return false;
  try {
    if (statSync(target).isDirectory()) {
      // shallow recursive delete
      rmrf(target);
    } else {
      unlinkSync(target);
    }
  } catch { return false; }
  return true;
}

function rmrf(p: string): void {
  try {
    for (const ent of readdirSync(p)) {
      const sub = join(p, ent);
      try {
        const st = statSync(sub);
        if (st.isDirectory()) rmrf(sub);
        else unlinkSync(sub);
      } catch { /* ignore */ }
    }
    rmdirSync(p);
  } catch { /* ignore */ }
}

/* -------------------------------------------------------------------------- */
/*                              Author from trace                              */
/* -------------------------------------------------------------------------- */

export interface RunTraceSummary {
  runId: string;
  successfulCommands: { command: string; exitCode: number | null; summary: string }[];
  relevantFiles: string[];
  description: string;
  nameHint?: string;
  validationCommands?: { id: string; command: string; cwd?: string }[];
  scope?: SkillScope;
}

export function createSkillFromRunTrace(trace: RunTraceSummary, opts: { workspaceRoot: string; builtinRoot?: string; userHome?: string; createdBy?: string }): ReaperSkill {
  const name = trace.nameHint ?? `run-${trace.runId.slice(0, 8)}`;
  const commands = trace.successfulCommands.map((c) => `- \`${c.command}\` — ${c.summary}`).join("\n");
  const files = trace.relevantFiles.map((f) => `- \`${f}\``).join("\n");
  const body = [
    `# ${name}`,
    "",
    trace.description,
    "",
    "## Validated commands",
    commands || "(none captured)",
    "",
    "## Files involved",
    files || "(none captured)",
    "",
    "## Notes",
    "This skill was created automatically from a successful run trace. Verify validation commands still pass before relying on it.",
  ].join("\n");
  const createInput: CreateSkillInput = {
    name,
    description: trace.description,
    type: "prompt",
    scope: trace.scope ?? "project",
    body,
    allowedTools: ["view_file", "edit_file", "run_command", "run_tests"],
    arguments: [],
    memoryPolicy: { mayReadProjectMemory: true, mayWriteProjectMemory: true, mayReadUserMemory: false, mayWriteUserMemory: false },
    workspaceRoot: opts.workspaceRoot,
    ...(opts.builtinRoot !== undefined ? { builtinRoot: opts.builtinRoot } : {}),
    ...(opts.userHome !== undefined ? { userHome: opts.userHome } : {}),
    createdBy: opts.createdBy ?? "reaper:auto-skill",
  };
  if (trace.validationCommands !== undefined) {
    createInput.validation = { commands: trace.validationCommands };
  }
  return createSkill(createInput);
}

/* -------------------------------------------------------------------------- */
/*                              Skill Selection                                 */
/* -------------------------------------------------------------------------- */

export interface SelectSkillsInput {
  query: string;
  context: { taskKeywords?: string[]; repoSignals?: string[]; fileGlobs?: string[] };
  candidates: ReaperSkill[];
  maxResults?: number;
}

export function selectRelevantSkills(input: SelectSkillsInput): ReaperSkill[] {
  const max = input.maxResults ?? 3;
  const q = input.query.toLowerCase();
  const keywords = (input.context.taskKeywords ?? []).map((k) => k.toLowerCase());
  const scored: { skill: ReaperSkill; score: number }[] = [];
  for (const s of input.candidates) {
    if (s.disableAutoInvocation) continue;
    let score = 0;
    if (s.name.toLowerCase().includes(q)) score += 3;
    if (s.description.toLowerCase().includes(q)) score += 2;
    if (s.whenToUse.toLowerCase().includes(q)) score += 1;
    for (const k of keywords) {
      if (s.whenToUse.toLowerCase().includes(k) || s.description.toLowerCase().includes(k)) score += 1;
    }
    if (score > 0) scored.push({ skill: s, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.skill);
}

/* -------------------------------------------------------------------------- */
/*                              Render for model                               */
/* -------------------------------------------------------------------------- */

export function renderSkillForModel(s: ReaperSkill, args: string[] = []): string {
  let body = s.body;
  // Substitute $ARGUMENTS
  if (args.length > 0) {
    body = body.replace(/\$ARGUMENTS/g, args.join(" "));
    args.forEach((a, i) => {
      body = body.replace(new RegExp(`\\$${i}\\b`, "g"), a);
    });
  }
  // Substitute named parameters
  for (let i = 0; i < s.arguments.length; i++) {
    const name = s.arguments[i]!;
    const val = args[i] ?? "";
    body = body.replace(new RegExp(`\\$${name}\\b`, "g"), val);
  }
  // Substitute ${REAPER_SKILL_DIR}
  body = body.replace(/\$\{REAPER_SKILL_DIR\}/g, s.skillDir);
  return body;
}

/* -------------------------------------------------------------------------- */
/*                              Nesting depth                                  */
/* -------------------------------------------------------------------------- */

export function skillNestingDepth(s: ReaperSkill): number {
  // A skill doesn't nest other skills directly; the depth is tracked
  // by the runtime as the skill is invoked. This helper computes the
  // declared depth from a meta annotation, or returns 0.
  const m = /<!--\s*reaper:nesting-depth\s*=\s*(\d+)\s*-->/.exec(s.body);
  if (!m) return 0;
  return parseInt(m[1] ?? "0", 10);
}
