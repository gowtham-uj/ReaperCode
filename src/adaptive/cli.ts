/**
 * CLI for the Adaptive Intelligence layer.
 *
 *   reaper swarm    — Model-driven subagents (single delegated agent)
 *     plan            Build a plan that may include a subagent
 *     list            List active/finished subagent instances
 *     show <id>       Show a subagent's output transcript
 *     status <id>     Show a subagent's status
 *     cancel <id>     Cancel a running subagent
 *     output <id>     Tail a subagent's output
 *     agents          List built-in subagent types
 *
 *   reaper skill    — Skill authoring & lookup
 *   reaper memory   — Persistent memory store
 *   reaper visual   — Visual analysis (gated by model capability)
 *   reaper capability — Model capabilities
 *   reaper redact   — Secret redaction
 *
 * Each subcommand is a function that takes parsed argv and returns
 * an exit code. The runtime wires this CLI in as a subcommand group.
 *
 * Commands are written so they never depend on a UI or interactive
 * TTY; output is plain text or JSON. The CLI never stores secrets.
 */

import { existsSync,  readFileSync} from "node:fs";
import { join} from "node:path";

import {
  parseSkillFromRaw,
  serializeSkill,
  createSkill,
  selectRelevantSkills,
  renderSkillForModel,
  loadSkill,
} from "./skill-author.js";
import { SkillMemoryRegistry } from "./skill-memory-registry.js";
import { PersistentMemoryStore } from "./persistent-memory-store.js";
import { MemoryScopePolicy } from "./memory-scope-policy.js";
import { VisualInputAnalyzer } from "./visual-input-analyzer.js";
import { ModelCapabilitiesRegistry } from "./model-capabilities.js";
import { Hooks } from "./hooks.js";
import { redactSecrets } from "./redact.js";

// Skills + Extensions plugin system (src/skills/, src/extensions/, src/commands/)
import { SkillRegistry } from "../skills/registry.js";
import { SkillLifecycle } from "../skills/lifecycle.js";
import { TrustResolver as SkillTrustResolver } from "../skills/trust.js";
import { discoverSkills} from "../skills/discovery.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { ExtensionLifecycle } from "../extensions/lifecycle.js";
import { HookRunner } from "../extensions/hook-runner.js";
import { HookLifecycle } from "../hooks/lifecycle.js";
import { SlashCommandRegistry, ConsoleHost } from "../extensions/slash-command-registry.js";
import { registerBuiltinCommands } from "../commands/index.js";
import { builtinSkillsRoot } from "../skills/built-in/index.js";
import { runExec, type ExecRunnerOptions } from "./exec-runner.js";

// Subagent (model-driven swarm) imports
import { LaborMarket, ForegroundSubagentRunner, SubagentStore, parseAgentTypeYaml } from "./swarm/index.js";
import type { SubagentModelFn } from "./swarm/index.js";

export interface ReaperCLIOptions {
  workspaceRoot: string;
  userHome?: string;
  capabilities?: ModelCapabilitiesRegistry;
  /** A custom model gateway for swarm foreground runs. */
  swarmModelCall?: SubagentModelFn;
  /** Known model aliases accepted by the Agent tool. */
  knownModels?: string[];
}

export class ReaperCLI {
  private readonly opts: ReaperCLIOptions;
  private readonly skillRegistry: SkillMemoryRegistry;
  private readonly memory: PersistentMemoryStore;
  private readonly scopePolicy: MemoryScopePolicy;
  private readonly visual: VisualInputAnalyzer;
  // Subagent runtime state
  private readonly swarmMarket: LaborMarket;
  private readonly swarmStore: SubagentStore;
  private readonly hooks: Hooks;

  // Skills + Extensions plugin system state (lazy — created on first use)
  private _newSkillRegistry: SkillRegistry | null = null;
  private _newSkillLifecycle: SkillLifecycle | null = null;
  private _newExtensionRegistry: ExtensionRegistry | null = null;
  private _newExtensionLifecycle: ExtensionLifecycle | null = null;
  private _hookRunner: HookRunner | null = null;
  private _newHookLifecycle: HookLifecycle | null = null;
  private _slashRegistry: SlashCommandRegistry | null = null;

  constructor(opts: ReaperCLIOptions) {
    this.opts = opts;
    this.skillRegistry = new SkillMemoryRegistry({ workspaceRoot: opts.workspaceRoot, ...(opts.userHome !== undefined ? { userHome: opts.userHome } : {}) });
    this.memory = new PersistentMemoryStore({ workspaceRoot: opts.workspaceRoot, ...(opts.userHome !== undefined ? { userHome: opts.userHome } : {}) });
    this.scopePolicy = new MemoryScopePolicy();
    this.visual = new VisualInputAnalyzer({ workspaceRoot: opts.workspaceRoot, ...(opts.capabilities !== undefined ? { capabilities: opts.capabilities } : {}) });
    this.swarmMarket = new LaborMarket();
    // Load any built-in types from the default directory; ignore failures
    try { this.swarmMarket.loadBuiltinTypesFromDir(); } catch { /* no built-ins on disk */ }
    this.swarmStore = new SubagentStore({ workspaceRoot: opts.workspaceRoot });
    this.hooks = new Hooks();
  }

  async run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [group, subcommand, ...rest] = argv;
    if (!group || group === "--help" || group === "-h") { return this.usage(); }
    try {
      switch (group) {
        case "skill":   return await this.skill(subcommand, rest);
        case "extensions": return await this.extensions(subcommand, rest);
        case "memory":  return await this.memory_(subcommand, rest);
        case "swarm":   return await this.swarm(subcommand, rest);
        case "visual":  return await this.visual_(subcommand, rest);
        case "capability": return await this.capability(subcommand, rest);
        case "redact":  return await this.redactCmd(undefined, subcommand !== undefined ? [subcommand, ...rest] : rest);
        case "slash":   return await this.slash(subcommand, subcommand !== undefined ? rest : []);
        case "exec":    return await this.execGroup(subcommand, rest);
        case "tui":     return await this.tuiGroup(subcommand, rest);
        default:        return { exitCode: 2, stdout: "", stderr: `unknown group "${group}"` };
      }
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  /* --- skill --- */
  private async skill(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    switch (sub) {
      case "list":   return this.skillList(args);
      case "show":   return this.skillShow(args);
      case "create": return this.skillCreate(args);
      case "disable":return this.skillDisable(args);
      case "delete": return this.skillDelete(args);
      case "search": return this.skillSearch(args);
      case "render": return this.skillRender(args);
      // New skill-folder plugin subcommands (src/skills/)
      case "add":    return this.skillAdd(args);
      case "enable": return this.skillEnable(args);
      case "trust":  return this.skillTrust(args);
      case "untrust":return this.skillUntrust(args);
      case "test":   return this.skillTest(args);
      case "doctor": return this.skillDoctor(args);
      case undefined:
        return { exitCode: 2, stdout: "", stderr: "skill subcommand required (list|show|create|disable|delete|search|render|add|enable|trust|untrust|test|doctor)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown skill subcommand "${sub}"` };
    }
  }

  private async skillList(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scope = (args[0] as "project" | "user" | "builtin" | undefined) ?? undefined;
    const skills = this.skillRegistry.listSkills(scope);
    const lines = skills.map((s) => `${s.scope}\t${s.name}\t${s.type}\t${s.disableAutoInvocation ? "disabled" : "active"}\t${s.description}`);
    return { exitCode: 0, stdout: `scope\tname\ttype\tstatus\tdescription\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async skillShow(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const name = args[0];
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const skill = this.skillRegistry.getSkill(name);
    if (!skill) {
      const candidates = [
        join(this.opts.workspaceRoot, ".reaper", "skills", name, "SKILL.md"),
        join(this.opts.userHome ?? process.env.HOME ?? "~", ".reaper", "skills", name, "SKILL.md"),
      ];
      let found: ReturnType<typeof parseSkillFromRaw> = null;
      for (const c of candidates) {
        found = loadSkill(c, c.includes(process.env.HOME ?? "~") ? "user" : "project");
        if (found) break;
      }
      if (!found) return { exitCode: 1, stdout: "", stderr: `skill "${name}" not found` };
      return { exitCode: 0, stdout: serializeSkill(found), stderr: "" };
    }
    return { exitCode: 0, stdout: serializeSkill(skill), stderr: "" };
  }

  private async skillCreate(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const opts = parseFlags(args);
    if (typeof opts.name !== "string") return { exitCode: 2, stdout: "", stderr: "--name required" };
    if (typeof opts.description !== "string") return { exitCode: 2, stdout: "", stderr: "--description required" };
    if (typeof opts.scope !== "string" || !["project", "user", "builtin"].includes(opts.scope)) {
      return { exitCode: 2, stdout: "", stderr: "--scope must be project|user|builtin" };
    }
    if (typeof opts.body !== "string") return { exitCode: 2, stdout: "", stderr: "--body required (path to markdown file or inline text)" };
    let body = opts.body;
    if (existsSync(body)) body = readFileSync(body, "utf8");
    const skill = createSkill({
      name: opts.name,
      description: opts.description,
      type: (opts.type as "prompt" | "workflow" | "checklist" | "tool-guide" | undefined) ?? "prompt",
      scope: opts.scope as "project" | "user" | "builtin",
      whenToUse: typeof opts.whenToUse === "string" ? opts.whenToUse : opts.description,
      body,
      allowedTools: typeof opts.allowedTools === "string" ? opts.allowedTools.split(",") : [],
      arguments: typeof opts.arguments === "string" ? opts.arguments.split(",") : [],
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.opts.userHome !== undefined ? { userHome: this.opts.userHome } : {}),
    });
    this.skillRegistry.upsertSkill(skill);
    return { exitCode: 0, stdout: JSON.stringify({ name: skill.name, scope: skill.scope, sourcePath: skill.sourcePath }, null, 2) + "\n", stderr: "" };
  }

  private async skillDisable(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name, reason] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const ok = this.skillRegistry.disable(name, reason ?? "manual");
    return ok ? { exitCode: 0, stdout: `disabled ${name}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: `skill "${name}" not found` };
  }

  private async skillDelete(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const ok = this.skillRegistry.forget(name);
    return ok ? { exitCode: 0, stdout: `deleted ${name}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: `skill "${name}" not found` };
  }

  private async skillSearch(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [query, ...rest] = args;
    if (!query) return { exitCode: 2, stdout: "", stderr: "query required" };
    const candidates = this.skillRegistry.listSkills();
    const context = { taskKeywords: rest };
    const picks = selectRelevantSkills({ query, context, candidates, maxResults: 5 });
    if (picks.length === 0) return { exitCode: 0, stdout: "(no matches)\n", stderr: "" };
    return { exitCode: 0, stdout: picks.map((s) => `${s.name}\t${s.scope}\t${s.description}`).join("\n") + "\n", stderr: "" };
  }

  private async skillRender(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name, ...rest] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const skill = this.skillRegistry.getSkill(name);
    if (!skill) return { exitCode: 1, stdout: "", stderr: `skill "${name}" not found` };
    const rendered = renderSkillForModel(skill, rest);
    return { exitCode: 0, stdout: rendered, stderr: "" };
  }

  /* --- memory --- */
  private async memory_(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    switch (sub) {
      case "list":     return this.memoryList(args);
      case "search":   return this.memorySearch(args);
      case "forget":   return this.memoryForget(args);
      case "summarize":return this.memorySummarize(args);
      case "health":   return this.memoryHealth(args);
      case undefined:  return { exitCode: 2, stdout: "", stderr: "memory subcommand required (list|search|forget|summarize|health)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown memory subcommand "${sub}"` };
    }
  }

  private async memoryList(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scope = (args[0] as "transient" | "project" | "user" | "machine" | "secret" | undefined) ?? "project";
    const records = this.memory.list(scope);
    const lines = records.map((r) => `${r.id}\t${r.scope}\t${r.kind}\t${r.confidence.toFixed(2)}\t${r.content}`);
    return { exitCode: 0, stdout: `id\tscope\tkind\tconf\tcontent\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async memorySearch(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [query] = args;
    if (!query) return { exitCode: 2, stdout: "", stderr: "query required" };
    const records = this.memory.search(query);
    const lines = records.map((r) => `${r.id}\t${r.scope}\t${r.kind}\t${r.confidence.toFixed(2)}\t${r.content}`);
    return { exitCode: 0, stdout: `id\tscope\tkind\tconf\tcontent\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async memoryForget(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "memory id required" };
    const ok = this.memory.forget(id);
    return ok ? { exitCode: 0, stdout: `forgot ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: `memory "${id}" not found` };
  }

  private async memorySummarize(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const scope = (args[0] as "transient" | "project" | "user" | "machine" | "secret" | undefined) ?? "project";
    return { exitCode: 0, stdout: this.memory.summarize(scope) + "\n", stderr: "" };
  }

  private async memoryHealth(_: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const h = this.memory.healthCheck();
    return { exitCode: 0, stdout: JSON.stringify(h, null, 2) + "\n", stderr: "" };
  }

  /* --- subagent runtime --- */
  private async swarm(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    switch (sub) {
      case "plan":      return this.swarmPlan(args);
      case "list":      return this.swarmList(args);
      case "show":      return this.swarmShow(args);
      case "status":    return this.swarmStatus(args);
      case "cancel":    return this.swarmCancel(args);
      case "output":    return this.swarmOutput(args);
      case "agents":    return this.swarmAgents_(args);
      case "run":       return this.swarmRun(args);
      case undefined:   return { exitCode: 2, stdout: "", stderr: "swarm subcommand required (plan|list|show|status|cancel|output|agents|run)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown swarm subcommand "${sub}"` };
    }
  }

  private async swarmPlan(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const opts = parseFlags(args);
    const task = typeof opts.task === "string" ? opts.task : args[0];
    if (!task) return { exitCode: 2, stdout: "", stderr: "--task required" };
    // swarm plan only suggests a subagent type (single delegation).
    const visualAvailable = this.opts.capabilities?.isVisualSupported() ?? true;
    let type = "coder";
    if (/(\bexplor|\bfind\b|\bmap\b|\bsearch\b)/i.test(task)) type = "explore";
    else if (/(\bplan|\barchitect|\bstep.by.step)/i.test(task)) type = "plan";
    if (visualAvailable === false && type === "coder") {
      // coder is fine without visual
    }
    return { exitCode: 0, stdout: JSON.stringify({ mode: "single_subagent", subagent_type: type, reason: "picked by task keyword heuristic" }, null, 2) + "\n", stderr: "" };
  }

  private async swarmList(_: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const records = this.swarmStore.list();
    const lines = records.map((r) => `${r.agentId}\t${r.status}\t${r.subagentType}\t${r.description}`);
    return { exitCode: 0, stdout: `agentId\tstatus\tsubagent_type\tdescription\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async swarmShow(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "agentId required" };
    const r = this.swarmStore.readInstance(id);
    if (!r) return { exitCode: 1, stdout: "", stderr: `subagent "${id}" not found` };
    return { exitCode: 0, stdout: JSON.stringify(r, null, 2) + "\n", stderr: "" };
  }

  private async swarmStatus(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "agentId required" };
    const r = this.swarmStore.readInstance(id);
    if (!r) return { exitCode: 1, stdout: "", stderr: `subagent "${id}" not found` };
    return { exitCode: 0, stdout: JSON.stringify({ agentId: r.agentId, status: r.status, subagentType: r.subagentType, description: r.description, createdAt: r.createdAt, updatedAt: r.updatedAt }, null, 2) + "\n", stderr: "" };
  }

  private async swarmCancel(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id, reason] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "agentId required" };
    const r = this.swarmStore.readInstance(id);
    if (!r) return { exitCode: 1, stdout: "", stderr: `subagent "${id}" not found` };
    this.swarmStore.setStatus(id, "killed");
    return { exitCode: 0, stdout: `cancelled ${id} (${reason ?? "manual"})\n`, stderr: "" };
  }

  private async swarmOutput(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "agentId required" };
    const path = this.swarmStore.outputPath(id);
    if (!existsSync(path)) return { exitCode: 1, stdout: "", stderr: `no output at ${path}` };
    return { exitCode: 0, stdout: readFileSync(path, "utf8"), stderr: "" };
  }

  private async swarmAgents_(_: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const types = this.swarmMarket.listBuiltinTypes();
    const lines = types.map((t) => `${t.name}\t${t.defaultModel ?? "inherit"}\t${t.supportsBackground ? "yes" : "no"}\t${t.description}`);
    return { exitCode: 0, stdout: `name\tmodel\tbackground\tdescription\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async swarmRun(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.opts.swarmModelCall) return { exitCode: 1, stdout: "", stderr: "swarm run requires a model gateway" };
    const opts = parseFlags(args);
    const prompt = typeof opts.prompt === "string" ? opts.prompt : (args.length > 0 ? args.join(" ") : "");
    if (!prompt) return { exitCode: 2, stdout: "", stderr: "--prompt required (or pass as positional args)" };
    const description = typeof opts.description === "string" ? opts.description : "swarm cli run";
    const subagentType = typeof opts.type === "string" ? opts.type : "coder";
    const model = typeof opts.model === "string" ? opts.model : null;
    const runner = new ForegroundSubagentRunner({
      store: this.swarmStore,
      market: this.swarmMarket,
      modelCall: this.opts.swarmModelCall,
      parentBasePrompt: "You are a Reaper subagent running headless from the CLI.",
      parentTools: [],
    });
    const result = await runner.run({
      description,
      prompt,
      requestedType: subagentType,
      model,
      resume: null,
      timeout: typeof opts.timeout === "string" ? Number(opts.timeout) : null,
    });
    return {
      exitCode: result.status === "completed" ? 0 : 1,
      stdout: JSON.stringify(result, null, 2) + "\n",
      stderr: "",
    };
  }

  /* --- visual --- */
  private async visual_(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.visual.isAvailable()) {
      return { exitCode: 1, stdout: "", stderr: `visual disabled: ${this.visual.unavailableReason() ?? "model lacks image input"}` };
    }
    switch (sub) {
      case "list":     return this.visualList(args);
      case "analyze":  return this.visualAnalyze(args);
      case "bridge":   return this.visualBridge(args);
      case undefined:  return { exitCode: 2, stdout: "", stderr: "visual subcommand required (list|analyze|bridge)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown visual subcommand "${sub}"` };
    }
  }

  private async visualList(_: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const list = this.visual.listArtifacts();
    const lines = list.map((a) => `${a.id}\t${a.mimeType}\t${a.path}\t${a.source}\t${a.relatedRunId ?? ""}`);
    return { exitCode: 0, stdout: `id\tmime\tpath\tsource\trun\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async visualAnalyze(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [file, ...rest] = args;
    if (!file) return { exitCode: 2, stdout: "", stderr: "file path required" };
    const a = this.visual.registerArtifact({ path: file, source: "user_upload" });
    if (!a) return { exitCode: 1, stdout: "", stderr: `could not register ${file}` };
    const prompt = rest.join(" ");
    const outcome = await this.visual.tryAnalyzeScreenshot(a.id, prompt ? { goal: prompt } : undefined);
    if (!outcome.available) return { exitCode: 1, stdout: "", stderr: `visual unavailable: ${outcome.reason}` };
    return { exitCode: 0, stdout: JSON.stringify(outcome.result, null, 2) + "\n", stderr: "" };
  }

  private async visualBridge(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "analysis id required" };
    const bridge = this.visual.bridgeAnalysis(id);
    return { exitCode: 0, stdout: JSON.stringify(bridge, null, 2) + "\n", stderr: "" };
  }

  /* --- capability --- */
  private async capability(sub: string | undefined, _args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.opts.capabilities) return { exitCode: 1, stdout: "", stderr: "no capabilities registry configured" };
    switch (sub) {
      case "show":  return { exitCode: 0, stdout: JSON.stringify(this.opts.capabilities.current(), null, 2) + "\n", stderr: "" };
      case "probe": {
        const c = await this.opts.capabilities.refresh();
        return { exitCode: 0, stdout: JSON.stringify(c, null, 2) + "\n", stderr: "" };
      }
      case undefined: return { exitCode: 2, stdout: "", stderr: "capability subcommand required (show|probe)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown capability subcommand "${sub}"` };
    }
  }

  /* --- redact --- */
  /** `reaper redact <file|stdin text...>`. The first non-flag argument is
   *  treated as a file path if it exists on disk; otherwise the
   *  remaining arguments are joined as inline text. */
  private async redactCmd(_sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let text = "";
    if (args.length === 0) return { exitCode: 2, stdout: "", stderr: "redact: text or file path required" };
    const first = args[0]!;
    if (existsSync(first)) text = readFileSync(first, "utf8");
    else text = args.join(" ");
    const { redacted, redactions } = redactSecrets(text);
    return { exitCode: 0, stdout: JSON.stringify({ redacted, redactions }, null, 2) + "\n", stderr: "" };
  }

  /* --- usage --- */
  /* --- exec (yolo single-prompt runner) --- */
  private async execGroup(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (sub !== "run") {
      return { exitCode: 2, stdout: "", stderr: `exec subcommand required (run); got "${sub ?? ""}"` };
    }
    const flags = parseFlags(args);
    const prompt = flags["prompt"] ?? args.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!prompt) {
      return { exitCode: 2, stdout: "", stderr: "exec run --prompt <text> required (or pass the prompt positionally)" };
    }
    const workspaceRoot = flags["workspace"] ?? this.opts.workspaceRoot;
    const wantJson = flags["json"] === "true" || flags["json"] === "1";
    const model = flags["model"];
    const maxTokens = flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined;
    const timeoutMs = flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined;
    const providerRaw = flags["provider"];
    const isExecProvider = (value: string | undefined): value is NonNullable<ExecRunnerOptions["provider"]> =>
      value === "openai" || value === "anthropic" || value === "minimax" || value === "deepseek" || value === "nuralwatt";
    let provider: ExecRunnerOptions["provider"] | undefined = isExecProvider(providerRaw) ? providerRaw : undefined;
    let selectedModel = model;
    if (this.opts.userHome === undefined) {
      const { seedEnvFromOnboarding } = await import("../tui/provider-onboarding.js");
      const saved = seedEnvFromOnboarding();
      const savedProvider: ExecRunnerOptions["provider"] | undefined = isExecProvider(saved?.provider) ? saved.provider : undefined;
      if (!provider && savedProvider) {
        provider = savedProvider;
      }
      if (!selectedModel && savedProvider && provider === savedProvider && saved) {
        selectedModel = saved.model;
      }
    }
    const reasoningEffortRaw = flags["reasoning-effort"];
    const reasoningEffort = reasoningEffortRaw === "low" || reasoningEffortRaw === "medium" || reasoningEffortRaw === "high"
      ? reasoningEffortRaw
      : undefined;
    try {
      const result = await runExec({
        workspaceRoot,
        prompt,
        ...(selectedModel !== undefined ? { model: selectedModel } : {}),
        ...(maxTokens !== undefined && Number.isFinite(maxTokens) ? { maxTokens } : {}),
        ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      });
      if (wantJson) {
        return { exitCode: result.status === "completed" ? 0 : 1, stdout: JSON.stringify(result, null, 2) + "\n", stderr: "" };
      }
      const lines: string[] = [];
      lines.push(`status: ${result.status}`);
      lines.push(`duration: ${result.durationMs}ms`);
      if (result.trajectoryPath) lines.push(`trajectory: ${result.trajectoryPath}`);
      if (result.contentFingerprint) lines.push(`fingerprint: ${result.contentFingerprint}`);
      if (result.verification) {
        lines.push(`verification: ${result.verification.ok ? "ok" : "fail"} (attempts=${result.verification.attemptCount}${result.verification.reason ? `, reason=${result.verification.reason}` : ""})`);
      }
      if (result.assistantMessage) {
        lines.push("");
        lines.push("--- assistant ---");
        lines.push(result.assistantMessage);
      }
      if (result.toolResults.length) {
        lines.push("");
        lines.push(`--- tool results (${result.toolResults.length}) ---`);
        for (const tr of result.toolResults) {
          lines.push(`- ${tr.name}${tr.id ? ` [${tr.id}]` : ""}`);
        }
      }
      if (result.notices.length) {
        lines.push("");
        lines.push("--- notices ---");
        for (const n of result.notices) lines.push(`[${n.kind}] ${n.message}`);
      }
      return { exitCode: result.status === "completed" ? 0 : 1, stdout: lines.join("\n") + "\n", stderr: "" };
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  /* --- tui --- */
  /** Interactive Ink-based REPL. The TUI mounts and owns process.exit;
   *  this method blocks until the Ink instance unmounts. */
  private async tuiGroup(_sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const flags = parseFlags(args);
    const slashRegistry = this.ensureSlashRegistry();

    // Seed env from any saved onboarding file, then decide whether
    // to run the picker before the TUI mounts. The user can also
    // re-trigger via the /provider slash command once they're inside
    // the TUI.
    const { hasAnyAuth, seedEnvFromOnboarding, loadOnboarding } =
      await import("../tui/provider-onboarding.js");
    const { autoDetectProvider } = await import("../model/provider/registry.js");
    const { findProviderDescriptor } = await import("../model/provider/catalog.js");
    const saved = seedEnvFromOnboarding();
    const explicitProvider = flags["provider"];
    const needsOnboarding = !hasAnyAuth() && !explicitProvider;

    // Resolve the active provider in priority order:
    //   1. Explicit --provider flag.
    //   2. Saved onboarding file (the user already picked).
    //   3. Auto-detect from env (the registry walks the catalog).
    //   4. Fall back to anthropic for the legacy case where the user
    //      has set ANTHROPIC_AUTH_TOKEN but hasn't onboarded.
    const detected = explicitProvider
      ? findProviderDescriptor(explicitProvider)
      : saved
        ? findProviderDescriptor(saved.provider)
        : autoDetectProvider();
    const activeProviderId = detected?.id ?? "anthropic";

    // The model is: explicit --model, then the saved onboarding's
    // model, then the catalog's defaultModel. We don't fall back to
    // a hardcoded string — the catalog owns defaults now.
    const explicitModel = flags["model"];
    const modelFromOnboarding = loadOnboarding()?.model;
    const model = explicitModel
      ?? modelFromOnboarding
      ?? findProviderDescriptor(activeProviderId)?.defaultModel
      ?? "claude-opus-4-8";

    const provider = activeProviderId as
      | "anthropic" | "openai" | "minimax" | "deepseek";

    const { renderTui } = await import("../tui/render.js");
    // The engine driver is constructed inside renderTui. It builds
    // the yolo config + Hooks adapter and routes events into the
    // SessionStore. We just mount Ink and wait for the user to exit.
    const handle = renderTui({
      workspaceRoot: this.opts.workspaceRoot,
      model,
      provider,
      slashRegistry,
      needsOnboarding,
    });
    await handle.done;
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  private usage(): { exitCode: number; stdout: string; stderr: string } {
    const usage = [
      "reaper <group> <subcommand> [args]",
      "groups:",
      "  skill       list | show | create | disable | delete | search | render",
      "              add | enable | trust | untrust | test | doctor",
      "  extensions  list | add | enable | disable | trust | untrust | doctor | remove",
      "  slash       /<name> [args...]   (host-agnostic slash command registry)",
      "  memory      list | search | forget | summarize | health",
      "  swarm       plan | list | show | status | cancel | output | agents | run",
      "  visual      list | analyze | bridge",
      "  capability  show | probe",
      "  redact      <file|->",
      "  exec        run --prompt <text> [--workspace <dir>] [--model <id>] [--provider anthropic|openai|minimax|deepseek|nuralwatt] [--reasoning-effort low|medium|high] [--max-tokens N] [--timeout-ms N] [--json]",
      "  tui         interactive REPL (default if no group given) [--model <id>] [--provider anthropic|openai|minimax|deepseek|nuralwatt] [--workspace <dir>]",
    ].join("\n");
    return { exitCode: 0, stdout: usage + "\n", stderr: "" };
  }

  /* --- skills (new plugin subcommands) --- */

  private ensureNewSkillRegistry(): { registry: SkillRegistry; lifecycle: SkillLifecycle } {
    if (!this._newSkillRegistry) {
      this._newSkillRegistry = new SkillRegistry({ builtinMetadata: {} });
      // Load built-ins so `skill list` shows all 17.
      try {
        const userHome = this.opts.userHome ?? process.env.HOME ?? "";
        const resolver = new SkillTrustResolver({
          builtinRoot: builtinSkillsRoot(),
          userHomeSkillsDir: join(userHome, ".reaper", "skills"),
          projectSkillsDir: join(this.opts.workspaceRoot, ".reaper", "skills"),
        });
        const result = discoverSkills({
          builtinRoot: builtinSkillsRoot(),
          userHomeSkillsDir: join(userHome, ".reaper", "skills"),
          projectSkillsDir: join(this.opts.workspaceRoot, ".reaper", "skills"),
          workspaceRoot: this.opts.workspaceRoot,
          resolver,
        });
        for (const r of result.records) this._newSkillRegistry.register(r);
        this._newSkillRegistry.syncTo(this.skillRegistry);
      } catch { /* no built-ins on disk yet */ }
    }
    if (!this._newSkillLifecycle) {
      const userHome = this.opts.userHome ?? process.env.HOME ?? "";
      this._newSkillLifecycle = new SkillLifecycle({
        registry: this._newSkillRegistry,
        memory: this.skillRegistry,
        resolver: new SkillTrustResolver({
          builtinRoot: builtinSkillsRoot(),
          userHomeSkillsDir: join(userHome, ".reaper", "skills"),
          projectSkillsDir: join(this.opts.workspaceRoot, ".reaper", "skills"),
        }),
        workspaceRoot: this.opts.workspaceRoot,
        userHome,
        builtinRoot: builtinSkillsRoot(),
        runCommand: async (cmd, cwd) => {
          const { execFile } = await import("node:child_process");
          return new Promise((resolve) => {
            execFile("bash", ["-lc", cmd], { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
              const exitCode = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
              resolve({ exitCode, stdout: String(stdout), stderr: String(stderr) });
            });
          });
        },
      });
    }
    return { registry: this._newSkillRegistry, lifecycle: this._newSkillLifecycle };
  }

  private async skillAdd(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const opts = parseFlags(args);
    const from = typeof opts.from === "string" ? opts.from : args[0];
    if (!from) return { exitCode: 2, stdout: "", stderr: "--from <path> required" };
    const scope = opts.scope === "project" ? "project" : "user";
    const trust = opts.trust === "true" || opts.trust === "1";
    const { lifecycle } = this.ensureNewSkillRegistry();
    const result = lifecycle.installFromPath({ srcPath: from, scope, trust });
    if (!result.ok) return { exitCode: 1, stdout: "", stderr: result.error ?? "install failed" };
    return { exitCode: 0, stdout: `installed "${result.name ?? from}" as ${scope}${trust ? " (trusted)" : ""}\n`, stderr: "" };
  }

  private async skillEnable(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const { registry } = this.ensureNewSkillRegistry();
    const ok = registry.enable(name);
    return ok ? { exitCode: 0, stdout: `enabled ${name}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: `skill "${name}" not found` };
  }

  private async skillTrust(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name, ...noteParts] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const { lifecycle } = this.ensureNewSkillRegistry();
    const result = lifecycle.trust(name, noteParts.join(" ") || "trusted via CLI");
    return result.ok ? { exitCode: 0, stdout: `trusted ${name}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: result.error ?? "trust failed" };
  }

  private async skillUntrust(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name, ...noteParts] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const { lifecycle } = this.ensureNewSkillRegistry();
    const result = lifecycle.untrust(name, noteParts.join(" ") || "untrusted via CLI");
    return result.ok ? { exitCode: 0, stdout: `untrusted ${name}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: result.error ?? "untrust failed" };
  }

  private async skillTest(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name] = args;
    if (!name) return { exitCode: 2, stdout: "", stderr: "skill name required" };
    const { lifecycle } = this.ensureNewSkillRegistry();
    const result = await lifecycle.testSkill(name);
    if (!result.ok) return { exitCode: 1, stdout: "", stderr: result.error ?? "test failed" };
    return { exitCode: 0, stdout: `test "${name}" passed (${result.results.length} command(s))\n`, stderr: "" };
  }

  private async skillDoctor(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [name] = args;
    const { registry } = this.ensureNewSkillRegistry();
    const reports = registry.doctor(name);
    if (reports.length === 0) return { exitCode: 1, stdout: "", stderr: name ? `skill "${name}" not found` : "(no skills)" };
    const lines: string[] = [];
    for (const r of reports) {
      const tag = r.ok ? "OK" : "FAIL";
      lines.push(`[${tag}] ${r.name}: ${r.errors.join("; ") || "no errors"}`);
    }
    const any = reports.some((r: { ok: boolean }) => !r.ok);
    return { exitCode: any ? 1 : 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  /* --- extensions --- */

  private ensureExtensionRegistry(): ExtensionRegistry {
    if (!this._newExtensionRegistry) {
      const builtinRoot = join(this.opts.workspaceRoot, ".reaper", "extensions-builtin");
      this._newExtensionRegistry = new ExtensionRegistry({
        workspaceRoot: this.opts.workspaceRoot,
        userHome: this.opts.userHome ?? process.env.HOME ?? "",
        builtinRoot,
      });
    }
    return this._newExtensionRegistry;
  }

  private ensureExtensionLifecycle(): ExtensionLifecycle {
    if (!this._newExtensionLifecycle) {
      this._newExtensionLifecycle = new ExtensionLifecycle(this.ensureExtensionRegistry());
    }
    return this._newExtensionLifecycle;
  }

  private ensureHookRunner(): HookRunner {
    if (!this._hookRunner) {
      this._hookRunner = new HookRunner();
    }
    return this._hookRunner;
  }

  private ensureHookLifecycle(): HookLifecycle {
    if (!this._newHookLifecycle) {
      this._newHookLifecycle = new HookLifecycle({
        runner: this.ensureHookRunner(),
        workspaceRoot: this.opts.workspaceRoot,
        userHome: this.opts.userHome ?? process.env.HOME ?? "",
      });
    }
    return this._newHookLifecycle;
  }

  private async extensions(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    switch (sub) {
      case "list":   return this.extList(args);
      case "add":    return this.extAdd(args);
      case "enable": return this.extEnable(args);
      case "disable":return this.extDisable(args);
      case "trust":  return this.extTrust(args);
      case "untrust":return this.extUntrust(args);
      case "doctor": return this.extDoctor(args);
      case "remove": return this.extRemove(args);
      case undefined:
        return { exitCode: 2, stdout: "", stderr: "extensions subcommand required (list|add|enable|disable|trust|untrust|doctor|remove)" };
      default: return { exitCode: 2, stdout: "", stderr: `unknown extensions subcommand "${sub}"` };
    }
  }

  private async extList(_args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const r = this.ensureExtensionRegistry();
    r.discover();
    const exts = r.list();
    if (exts.length === 0) return { exitCode: 0, stdout: "(no extensions installed)\n", stderr: "" };
    const lines = exts.map((e) => `${e.id}\t${e.trust}\t${e.status}\t${e.manifest.description ?? ""}`);
    return { exitCode: 0, stdout: `id\ttrust\tstatus\tdescription\n${lines.join("\n")}\n`, stderr: "" };
  }

  private async extAdd(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const opts = parseFlags(args);
    const from = typeof opts.from === "string" ? opts.from : args[0];
    if (!from) return { exitCode: 2, stdout: "", stderr: "--from <path> required" };
    const scope = opts.scope === "project" ? "project" : "user";
    const trust = opts.trust === "true" || opts.trust === "1";
    const r = this.ensureExtensionRegistry();
    const result = r.install({ srcPath: from, scope, trust });
    if (!result.ok) return { exitCode: 1, stdout: "", stderr: result.error ?? "install failed" };
    return { exitCode: 0, stdout: `installed "${result.id ?? from}" as ${scope}${trust ? " (trusted)" : ""}\n`, stderr: "" };
  }

  private async extEnable(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "extension id required" };
    const r = this.ensureExtensionRegistry();
    const out = r.enable(id);
    return out.ok ? { exitCode: 0, stdout: `enabled ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: out.error ?? "enable failed" };
  }

  private async extDisable(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "extension id required" };
    const r = this.ensureExtensionRegistry();
    const out = r.disable(id);
    return out.ok ? { exitCode: 0, stdout: `disabled ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: out.error ?? "disable failed" };
  }

  private async extTrust(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id, ...noteParts] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "extension id required" };
    const r = this.ensureExtensionRegistry();
    const out = r.trust_(id, noteParts.join(" ") || "trusted via CLI");
    return out.ok ? { exitCode: 0, stdout: `trusted ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: out.error ?? "trust failed" };
  }

  private async extUntrust(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id, ...noteParts] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "extension id required" };
    const r = this.ensureExtensionRegistry();
    const out = r.untrust(id, noteParts.join(" ") || "untrusted via CLI");
    return out.ok ? { exitCode: 0, stdout: `untrusted ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: out.error ?? "untrust failed" };
  }

  private async extDoctor(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    const r = this.ensureExtensionRegistry();
    const reports = r.doctor(id);
    if (reports.length === 0) return { exitCode: 1, stdout: "", stderr: id ? `extension "${id}" not found` : "(no extensions)" };
    const lines = reports.map((rep) => {
      const tag = rep.errors.length === 0 ? "OK" : "FAIL";
      return `[${tag}] ${rep.id}: ${rep.errors.join("; ") || "no errors"}\n  manifestOk=${rep.manifestOk} mainLoads=${rep.mainLoads} toolsHaveMetadata=${rep.toolsHaveMetadata} hookTimeoutsOk=${rep.hookTimeoutsOk} contributionsValid=${rep.contributionsValid}`;
    });
    const any = reports.some((rep) => rep.errors.length > 0);
    return { exitCode: any ? 1 : 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }

  private async extRemove(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [id] = args;
    if (!id) return { exitCode: 2, stdout: "", stderr: "extension id required" };
    const r = this.ensureExtensionRegistry();
    const out = r.uninstall(id);
    return out.ok ? { exitCode: 0, stdout: `removed ${id}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: out.error ?? "remove failed" };
  }

  /* --- slash --- */
  /** Host-agnostic slash-command entry: `reaper slash /<name> [args...]`. */
  private async slash(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const line = sub ? `/${sub}${args.length > 0 ? " " + args.join(" ") : ""}` : "";
    if (!line || line === "/") {
      const reg = this.ensureSlashRegistry();
      const host = new ConsoleHost();
      reg.help(host);
      return { exitCode: 0, stdout: "(slash commands listed on stdout)\n", stderr: "" };
    }
    const reg = this.ensureSlashRegistry();
    const result = await reg.handle(line, { host: new ConsoleHost() });
    if (!result.ok) return { exitCode: 1, stdout: result.output, stderr: result.error };
    return { exitCode: 0, stdout: result.output, stderr: "" };
  }

  private ensureSlashRegistry(): SlashCommandRegistry {
    if (!this._slashRegistry) {
      this._slashRegistry = new SlashCommandRegistry();
      const { registry: skillReg, lifecycle: skillLifecycle } = this.ensureNewSkillRegistry();
      const extReg = this.ensureExtensionRegistry();
      const hookLifecycle = this.ensureHookLifecycle();
      registerBuiltinCommands(this._slashRegistry, {
        skills: { registry: skillReg, lifecycle: skillLifecycle },
        extensions: { registry: extReg },
        hooks: { lifecycle: hookLifecycle },
        reload: {
          reloadSkills: () => ({ ok: true, loaded: skillReg.list({ includeUntrusted: true }).length }),
          reloadExtensions: () => ({ ok: true, loaded: extReg.discover().length }),
          reloadHooks: () => {
            const r = hookLifecycle.reload();
            return { ok: true, loaded: r.loaded, registered: r.registered };
          },
        },
      });
    }
    return this._slashRegistry;
  }
}

/* --- helpers --- */

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : "true";
      out[k] = v;
      i += v === "true" ? 1 : 2;
    } else {
      i++;
    }
  }
  return out;
}

// Re-export swarm utility for tests that need it
export { parseAgentTypeYaml };
