/**
 * LaborMarket — registry of built-in subagent types.
 *
 * Types are declared in YAML and registered at boot. The Agent
 * tool's description is rendered from this registry.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

import { parseFrontmatter, parseSimpleYaml } from "../skill-author.js";
import type { AgentTypeDefinition } from "./types.js";

const DEFAULT_BUILTIN_DIR = "src/adaptive/swarm/builtin-types";

export class LaborMarket {
  private readonly builtinTypes: Map<string, AgentTypeDefinition> = new Map();
  private readonly builtinDir: string;

  constructor(opts: { builtinDir?: string } = {}) {
    this.builtinDir = opts.builtinDir ?? DEFAULT_BUILTIN_DIR;
  }

  /** Add a built-in type. Throws on duplicate. */
  addBuiltinType(typeDef: AgentTypeDefinition): void {
    if (this.builtinTypes.has(typeDef.name)) {
      throw new Error(`builtin subagent type "${typeDef.name}" already registered`);
    }
    this.builtinTypes.set(typeDef.name, typeDef);
  }

  /** Get a built-in type by name. */
  getBuiltinType(name: string): AgentTypeDefinition | null {
    return this.builtinTypes.get(name) ?? null;
  }

  /** Get a built-in type by name; throw if missing. */
  requireBuiltinType(name: string): AgentTypeDefinition {
    const td = this.builtinTypes.get(name);
    if (!td) throw new Error(`builtin subagent type not found: ${name}`);
    return td;
  }

  /** List all registered types. */
  listBuiltinTypes(): AgentTypeDefinition[] {
    return [...this.builtinTypes.values()];
  }

  /** Load built-in types from YAML files in `builtinDir`. Each file is
   *  either a `SKILL.md`-style frontmatter (preferred) or a flat YAML
   *  with a top-level `name`, `description`, `when_to_use`, `tools`. */
  loadBuiltinTypesFromDir(dir: string = this.builtinDir): number {
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      const path = join(dir, name);
      try { if (statSync(path).isDirectory()) continue; } catch { continue; }
      const raw = readFileSync(path, "utf8");
      const typeDef = parseAgentTypeYaml(raw, path);
      this.addBuiltinType(typeDef);
      n++;
    }
    return n;
  }
}

/** Parse a YAML (or frontmatter-style) agent type spec. */
export function parseAgentTypeYaml(raw: string, sourcePath: string): AgentTypeDefinition {
  // Frontmatter form
  const fm = parseFrontmatter(raw);
  const obj: Record<string, unknown> = fm ? fm.frontmatter : parseSimpleYaml(raw);

  const name = String(obj["name"] ?? basename(sourcePath).replace(/\.ya?ml$/, ""));
  const description = String(obj["description"] ?? "");
  const whenToUse = String(obj["when_to_use"] ?? obj["whenToUse"] ?? "");
  const defaultModelRaw = obj["default_model"] ?? obj["defaultModel"] ?? null;
  const defaultModel = defaultModelRaw === null ? null : String(defaultModelRaw);
  const supportsBackground = obj["supports_background"] !== false;
  const systemPromptAddition = String(obj["system_prompt_addition"] ?? obj["systemPromptAddition"] ?? "");

  const allow = obj["allowed_tools"] ?? obj["allowedTools"];
  const exclude = obj["exclude_tools"] ?? obj["excludeTools"];
  const toolPolicy = (() => {
    if (Array.isArray(allow)) {
      return { mode: "allowlist" as const, tools: allow.map(String), excludeTools: Array.isArray(exclude) ? exclude.map(String) : [] };
    }
    return { mode: "inherit" as const, tools: [], excludeTools: Array.isArray(exclude) ? exclude.map(String) : [] };
  })();

  return {
    name,
    description,
    whenToUse,
    defaultModel,
    toolPolicy,
    supportsBackground,
    systemPromptAddition,
    sourcePath,
  };
}
