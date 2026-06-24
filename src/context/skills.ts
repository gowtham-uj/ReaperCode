import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  verified?: boolean;
  importance?: number;
  tags?: string[];
  lastVerifiedAt?: string;
}

export interface VerifiedSkillInput {
  runId: string;
  description: string;
  tags: string[];
  body: string;
  importance?: number;
  verifiedAt?: string;
}

/**
 * Simple frontmatter parser that handles key-value pairs without requiring a YAML library.
 */
function parseSimpleFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }

  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 5).trim();
  
  const frontmatter: Record<string, string> = {};
  const lines = yamlString.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      // Remove optional quotes
      frontmatter[key] = value.replace(/^["'](.*)["']$/, "$1");
    }
  }

  return { frontmatter, body };
}

function loadSkillFromFile(filePath: string): Skill | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter } = parseSimpleFrontmatter(content);
    
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    
    const name = frontmatter.name || (basename(filePath) === "SKILL.md" ? parentDirName : basename(filePath, ".md"));
    const description = frontmatter.description;

    if (!description) {
      return null;
    }

    return {
      name,
      description,
      filePath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === "true" || (frontmatter["disable-model-invocation"] as any) === true,
      ...(frontmatter.verified === "true" ? { verified: true } : {}),
      ...(frontmatter.importance && Number.isFinite(Number(frontmatter.importance)) ? { importance: Number(frontmatter.importance) } : {}),
      ...(frontmatter.tags ? { tags: frontmatter.tags.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(frontmatter.last_verified_at ? { lastVerifiedAt: frontmatter.last_verified_at } : {}),
    };
  } catch {
    return null;
  }
}

export function discoverSkills(workspaceRoot: string): Skill[] {
  const skills: Skill[] = [];
  const skillDirs = [
    join(workspaceRoot, ".opencode", "skills"),
    join(workspaceRoot, ".reaper", "skills"),
    join(workspaceRoot, "skills"),
  ];

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      
      // 1. Check for SKILL.md in direct subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = join(dir, entry.name, "SKILL.md");
          if (existsSync(skillMdPath)) {
            const skill = loadSkillFromFile(skillMdPath);
            if (skill) skills.push(skill);
          }
        }
      }

      // 2. Check for .md files in the skills directory itself
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
          const skill = loadSkillFromFile(join(dir, entry.name));
          if (skill) skills.push(skill);
        }
      }
    } catch {
      // Ignore errors reading directories
    }
  }

  // Deduplicate by name (prefer first found)
  const seen = new Set<string>();
  return skills.filter(s => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

export function formatSkillsForPrompt(skills: Skill[], query = "", limit = 10): string {
  const visibleSkills = rankSkillsForPrompt(skills.filter(s => !s.disableModelInvocation), query).slice(0, limit);
  if (visibleSkills.length === 0) return "";

  const lines = [
    "\n<available_skills>",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the activate_skill tool to load a skill's instructions when the task matches its description.",
    "",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${skill.name}</name>`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  return lines.join("\n");
}

export function rankSkillsForPrompt(skills: Skill[], query: string): Skill[] {
  const queryTerms = tokenize(query);
  return [...skills].sort((a, b) => scoreSkill(b, queryTerms) - scoreSkill(a, queryTerms));
}

export async function commitVerifiedSkill(workspaceRoot: string, input: VerifiedSkillInput): Promise<{ name: string; filePath: string }> {
  const tags = uniqueStrings(input.tags.map((item) => sanitizeToken(item)).filter(Boolean)).slice(0, 12);
  const signature = createHash("sha256")
    .update([input.description, tags.join(","), input.body].join("\n"))
    .digest("hex")
    .slice(0, 12);
  const name = `verified-${signature}`;
  const skillDir = join(workspaceRoot, ".reaper", "skills", name);
  const filePath = join(skillDir, "SKILL.md");
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const importance = clampImportance(input.importance ?? 1);
  await mkdir(skillDir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${sanitizeFrontmatter(input.description, 240)}`,
    "verified: true",
    `importance: ${importance}`,
    `tags: ${tags.join(",")}`,
    `last_verified_at: ${verifiedAt}`,
    "disable-model-invocation: false",
    "---",
  ].join("\n");
  await writeFile(filePath, `${frontmatter}\n\n${sanitizeBody(input.body)}\n`, "utf8");
  return { name, filePath };
}

function scoreSkill(skill: Skill, queryTerms: string[]): number {
  const skillTerms = tokenize([skill.name, skill.description, ...(skill.tags ?? [])].join(" "));
  const relevance = overlapScore(queryTerms, skillTerms);
  const importance = clampImportance(skill.importance ?? 1);
  const recency = recencyScore(skill.lastVerifiedAt);
  const verifiedBoost = skill.verified ? 1.25 : 1;
  return (relevance + 0.01) * importance * recency * verifiedBoost;
}

function tokenize(input: string): string[] {
  return uniqueStrings(input.toLowerCase().match(/[a-z0-9_+-]{3,}/g) ?? []);
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const matches = a.filter((term) => bSet.has(term)).length;
  return matches / Math.sqrt(a.length * b.length);
}

function recencyScore(iso: string | undefined): number {
  if (!iso) return 1;
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1.1;
  const ageDays = ageMs / 86_400_000;
  return Math.max(0.35, 1 / (1 + ageDays / 30));
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(0.1, Math.round(value * 100) / 100));
}

function sanitizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_+-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function sanitizeFrontmatter(value: string, maxChars: number): string {
  return value.replace(/\r?\n/g, " ").replace(/:/g, " -").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function sanitizeBody(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, 4000);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
