import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface LocalRule {
  outcome: "allow" | "deny";
  ruleId: string;
  pattern: RegExp;
  raw: string;
}

export interface LocalRuleSet {
  path: string;
  hash: string;
  rules: LocalRule[];
}

export async function loadLocalRules(workspaceRoot: string): Promise<LocalRuleSet | undefined> {
  const filePath = path.join(workspaceRoot, "rules.local.md");
  try {
    const content = await readFile(filePath, "utf8");
    const rules = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- allow:") || line.startsWith("- deny:"))
      .map((line, index) => parseRuleLine(line, index + 1));
    return {
      path: filePath,
      hash: createHash("sha256").update(content).digest("hex"),
      rules,
    };
  } catch {
    return undefined;
  }
}

function parseRuleLine(line: string, lineNumber: number): LocalRule {
  const match = /^-\s+(allow|deny):\s+(.+)$/.exec(line);
  if (!match) {
    throw new Error(`Invalid local rule syntax on line ${lineNumber}`);
  }
  const outcome = match[1]!;
  const patternText = match[2]!;
  return {
    outcome: outcome as "allow" | "deny",
    ruleId: `rules_local_${outcome}_${lineNumber}`,
    pattern: new RegExp(patternText),
    raw: line,
  };
}
