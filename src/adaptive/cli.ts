/**
 * CLI for the Adaptive Intelligence layer.
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
import { startAppServer } from "../app-server/server.js";


export interface ReaperCLIOptions {
  workspaceRoot: string;
  userHome?: string;
  capabilities?: ModelCapabilitiesRegistry;
}

export class ReaperCLI {
  private readonly opts: ReaperCLIOptions;
  private readonly skillRegistry: SkillMemoryRegistry;
  private readonly memory: PersistentMemoryStore;
  private readonly scopePolicy: MemoryScopePolicy;
  private readonly visual: VisualInputAnalyzer;
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
    this.hooks = new Hooks();
  }

  async run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const [group, subcommand, ...rest] = argv;
    if (!group || group === "--help" || group === "-h") { return this.usage(); }
    try {
      switch (group) {
        case "skill":   return await this.skill(subcommand, rest);
        // C3: `skills` is advertised as a top-level alias in
        // scripts/run-reaper.ts but had no case here, so `reaper skills
        // list` always exited 2. Route it to the same handler.
        case "skills":  return await this.skill(subcommand, rest);
        case "extensions": return await this.extensions(subcommand, rest);
        case "memory":  return await this.memory_(subcommand, rest);
        case "visual":  return await this.visual_(subcommand, rest);
        case "capability": return await this.capability(subcommand, rest);
        case "redact":  return await this.redactCmd(undefined, subcommand !== undefined ? [subcommand, ...rest] : rest);
        case "slash":   return await this.slash(subcommand, subcommand !== undefined ? rest : []);
        case "exec":    return await this.execGroup(subcommand, rest);
        case "app-server": return await this.appServer(subcommand !== undefined ? [subcommand, ...rest] : rest);
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
    const parsed = parseFlags(args);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const opts = parsed.flags;
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
  /**
   * `reaper redact --file <path>` or `reaper redact --text <text...>`.
   *
   * Mode is explicit. The previous behaviour ("treat argument 1 as a file
   * if it happens to exist") silently changed meaning based on the
   * filesystem: a literal string that collided with a real path caused the
   * file's contents to be read and printed instead of the text the caller
   * asked to redact — leaking whatever that file held. Bare positional
   * arguments are still accepted as text, but never auto-resolved to a
   * path.
   */
  private async redactCmd(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const argv = sub === undefined ? args : [sub, ...args];
    const parsed = parseFlags(argv);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const file = parsed.flags["file"];
    const inlineText = parsed.flags["text"];
    if (file !== undefined && inlineText !== undefined) {
      return { exitCode: 2, stdout: "", stderr: "redact: use only one of --file or --text" };
    }

    let text: string;
    if (file !== undefined) {
      if (!existsSync(file)) return { exitCode: 2, stdout: "", stderr: `redact: file not found: ${file}` };
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        return { exitCode: 2, stdout: "", stderr: `redact: unreadable file: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else {
      text = inlineText ?? parsed.positionals.join(" ");
      if (!text) return { exitCode: 2, stdout: "", stderr: "redact: --text <text> or --file <path> required" };
    }

    const { redacted, redactions } = redactSecrets(text);
    return { exitCode: 0, stdout: JSON.stringify({ redacted, redactions }, null, 2) + "\n", stderr: "" };
  }

  /* --- app server --- */
  private async appServer(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const parsed = parseFlags(args);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const flags = parsed.flags;
    const listen = flags["listen"] ?? "ws://127.0.0.1:0";
    let authToken = flags["auth-token"];
    const authTokenFile = flags["auth-token-file"];
    if (authToken && authTokenFile) {
      return { exitCode: 2, stdout: "", stderr: "Use only one of --auth-token or --auth-token-file" };
    }
    if (authTokenFile) {
      try {
        authToken = readFileSync(authTokenFile, "utf8").trim();
      } catch (error) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `--auth-token-file unreadable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const maxConcurrentTurns = parsePositiveIntegerFlag(flags["max-concurrent-turns"], 2, "--max-concurrent-turns");
    const maxMessageBytes = parsePositiveIntegerFlag(flags["max-message-bytes"], 1024 * 1024, "--max-message-bytes");
    const workspaceRoot = flags["workspace"] ?? this.opts.workspaceRoot;
    const server = await startAppServer({
      workspaceRoot,
      listen,
      ...(authToken ? { authToken } : {}),
      maxConcurrentTurns,
      maxMessageBytes,
    });
    process.stdout.write(`${JSON.stringify(server.ready)}\n`);

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void server.stop().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  /* --- usage --- */
  /* --- exec (yolo single-prompt runner) --- */
  private async execGroup(sub: string | undefined, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (sub !== "run") {
      return { exitCode: 2, stdout: "", stderr: `exec subcommand required (run); got "${sub ?? ""}"` };
    }
    const parsed = parseFlags(args, ["json", "stream-events"]);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const flags = parsed.flags;
    const promptFile = typeof flags["prompt-file"] === "string" ? flags["prompt-file"] : undefined;
    let prompt = flags["prompt"] ?? "";
    if (!prompt && promptFile) {
      // Read the prompt file and inline its content as the actual prompt.
      // Without this the model sees only the literal path string and has
      // to figure out to read the file itself.
      try {
        const { readFileSync } = await import("node:fs");
        prompt = readFileSync(promptFile, "utf8");
      } catch (error) {
        return {
          exitCode: 2,
          stdout: "",
          stderr: `--prompt-file unreadable: ${promptFile} (${error instanceof Error ? error.message : String(error)})`,
        };
      }
    }
    if (!prompt) {
      prompt = parsed.positionals.join(" ").trim();
    }
    if (!prompt) {
      return { exitCode: 2, stdout: "", stderr: "exec run --prompt <text> required (or pass the prompt positionally)" };
    }
    const workspaceRoot = flags["workspace"] ?? this.opts.workspaceRoot;
    const wantJson = flags["json"] === "true" || flags["json"] === "1";
    const model = flags["model"];
    const maxTokens = flags["max-tokens"] ? Number(flags["max-tokens"]) : undefined;
    const timeoutMs = flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined;
    const session = flags["session"];
    const wantStreamEvents = flags["stream-events"] === "true" || flags["stream-events"] === "1";
    if (wantStreamEvents) process.env.REAPER_STREAM_EVENTS = "1";
    const providerRaw = flags["provider"];
    const isExecProvider = (value: string | undefined): value is NonNullable<ExecRunnerOptions["provider"]> =>
      value === "openai" || value === "openai-codex" || value === "anthropic" || value === "minimax" || value === "deepseek" || value === "nuralwatt" || value === "nuralwatt2";
    let provider: ExecRunnerOptions["provider"] | undefined = isExecProvider(providerRaw) ? providerRaw : undefined;
    let selectedModel = model;
    if (this.opts.userHome === undefined) {
      const { seedEnvFromOnboarding } = await import("../model/provider-onboarding.js");
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
    const thinkingRaw = flags["thinking"];
    const thinking: ExecRunnerOptions["thinking"] | undefined =
      thinkingRaw === "on" || thinkingRaw === "enabled" || thinkingRaw === "1"
        ? "enabled"
        : thinkingRaw === "off" || thinkingRaw === "disabled" || thinkingRaw === "0"
          ? "disabled"
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
        ...(thinking !== undefined ? { thinking } : {}),
        ...(session !== undefined ? { session } : {}),
      });
      if (wantJson) {
        return { exitCode: result.status === "completed" ? 0 : 1, stdout: JSON.stringify(result, null, 2) + "\n", stderr: "" };
      }
      const isDev = process.env.REAPER_DEV === "1" || process.env.REAPER_DEV === "true";
      const lines: string[] = [];
      if (isDev) {
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
      }
      // In prod mode, model output was already streamed live — nothing extra to print.
      let summary = lines.length ? lines.join("\n") + "\n" : "";
      // C1: a non-completed run must never fail silently. In prod
      // (`REAPER_DEV` unset) the human summary is empty, so a failure
      // returned exit code 1 with no diagnostic. Always surface the
      // status + error notices to stderr on incomplete runs; keep stdout
      // clean for `--json`/`--stream-events` consumers.
      if (result.status !== "completed") {
        const failureLines = [`exec run ${result.status}`];
        const errors = result.notices.filter((n) => n.kind === "error");
        for (const n of errors) failureLines.push(`  ${n.message}`);
        if (errors.length === 0 && result.assistantMessage) failureLines.push(`  ${result.assistantMessage.slice(0, 500)}`);
        if (errors.length === 0) failureLines.push("  (no error notice was recorded — see the trajectory for details)");
        summary = `${summary}${failureLines.join("\n")}\n`;
      }
      // When stream-events is enabled, stdout is the pure JSONL event
      // stream; route the human summary to stderr so consumers can
      // pipe it without parsing noise.
      return {
        exitCode: result.status === "completed" ? 0 : 1,
        stdout: wantStreamEvents ? "" : summary,
        stderr: wantStreamEvents ? summary : "",
      };
    } catch (e) {
      return { exitCode: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
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
      "  visual      list | analyze | bridge",
      "  capability  show | probe",
      "  redact      <file|->",
      "  exec        run --prompt <text> [--session <name>] [--workspace <dir>] [--model <id>] [--provider anthropic|openai|openai-codex|minimax|deepseek|nuralwatt|nuralwatt2] [--reasoning-effort low|medium|high] [--thinking on|off] [--max-tokens N] [--timeout-ms N] [--json] [--stream-events]",
      "  app-server  [--listen ws://127.0.0.1:0] [--workspace <dir>] [--auth-token <token>|--auth-token-file <path>] [--max-concurrent-turns N]",
    ].join("\n");
    return { exitCode: 0, stdout: usage + "\n", stderr: "" };
  }

  /* --- skills (new plugin subcommands) --- */

  private ensureNewSkillRegistry(): { registry: SkillRegistry; lifecycle: SkillLifecycle } {
    if (!this._newSkillRegistry) {
      this._newSkillRegistry = new SkillRegistry({ builtinMetadata: {}, memory: this.skillRegistry });
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
    const parsed = parseFlags(args, ["trust"]);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const opts = parsed.flags;
    const from = typeof opts.from === "string" ? opts.from : parsed.positionals[0];
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
    const parsed = parseFlags(args, ["trust"]);
    if (parsed.error) return { exitCode: 2, stdout: "", stderr: parsed.error };
    const opts = parsed.flags;
    const from = typeof opts.from === "string" ? opts.from : parsed.positionals[0];
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

function parsePositiveIntegerFlag(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

interface ParsedFlags {
  flags: Record<string, string>;
  /** Non-flag arguments, plus everything after a `--` terminator. */
  positionals: string[];
  /** Set when the argv is malformed; callers should exit 2 with this. */
  error?: string;
}

/**
 * Parse `--flag value` / `--flag=value` / `--boolean` argv.
 *
 * Three things the previous parser got wrong:
 *  - A value-taking flag with no value (`--provider` at end of argv, or
 *    `--provider --json`) silently became the string `"true"`, which then
 *    flowed into provider/model selection as a bogus value.
 *  - `--key=value` was not understood at all; the whole token became a
 *    flag name.
 *  - There was no `--` terminator, so a positional that happens to start
 *    with `--` could not be passed.
 *
 * Flags named in `booleanFlags` take no value; every other flag requires
 * one, and its absence is a hard error rather than a silent default.
 */
function parseFlags(args: string[], booleanFlags: readonly string[] = []): ParsedFlags {
  const booleans = new Set(booleanFlags);
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      i += 1;
      continue;
    }

    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      const key = body.slice(0, eq);
      if (!key) return { flags, positionals, error: `malformed flag "${a}"` };
      flags[key] = body.slice(eq + 1);
      i += 1;
      continue;
    }

    if (!body) return { flags, positionals, error: `malformed flag "${a}"` };
    if (booleans.has(body)) {
      flags[body] = "true";
      i += 1;
      continue;
    }

    const next = args[i + 1];
    if (next === undefined || next === "--" || next.startsWith("--")) {
      return { flags, positionals, error: `--${body} requires a value` };
    }
    flags[body] = next;
    i += 2;
  }
  return { flags, positionals };
}

