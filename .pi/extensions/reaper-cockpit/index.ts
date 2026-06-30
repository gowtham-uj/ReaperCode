import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WorkflowMode =
  | "scout"
  | "plan"
  | "ship"
  | "fix"
  | "review"
  | "test"
  | "bench"
  | "failure-analysis"
  | "swarm"
  | "status";

type SwarmRoute = "direct" | "candidate" | "forced";

interface CockpitState {
  mode: WorkflowMode | "idle";
  swarmRoute: SwarmRoute;
  lastTool?: string;
  lastToolError?: boolean;
  lastCommand?: string;
}

const state: CockpitState = { mode: "idle", swarmRoute: "direct" };

export default function reaperCockpit(pi: ExtensionAPI): void {
  pi.registerFlag("reaper-yolo", {
    description: "Enable unrestricted Reaper cockpit YOLO mode with every discovered Pi tool active.",
    type: "boolean",
    default: true,
  });

  pi.registerFlag("reaper-auto-swarm", {
    description: "Automatically route parallelizable tasks through the Reaper agent swarm.",
    type: "boolean",
    default: true,
  });

  pi.on("session_start", async (_event, ctx) => {
    applyYoloTools(pi, ctx);
    renderStatus(ctx);
  });

  pi.on("input", async (event, ctx) => {
    if (
      event.source === "extension" ||
      pi.getFlag("reaper-auto-swarm") === false ||
      !pi.getActiveTools().includes("Agent") ||
      event.text.includes("[REAPER_AUTO_SWARM_ROUTE:")
    ) {
      return { action: "continue" };
    }

    state.swarmRoute = classifySwarmRoute(event.text);
    renderStatus(ctx);
    if (state.swarmRoute === "direct") return { action: "continue" };

    return {
      action: "transform",
      text: `${buildAutoSwarmUserDirective(state.swarmRoute)}\n\nOriginal user task:\n${event.text}`,
      images: event.images,
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (pi.getFlag("reaper-auto-swarm") === false || !pi.getActiveTools().includes("Agent")) {
      state.swarmRoute = "direct";
      renderStatus(ctx);
      return;
    }

    state.swarmRoute = classifySwarmRoute(event.prompt);
    renderStatus(ctx);
    if (state.swarmRoute === "direct") return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildAutoSwarmInstructions(state.swarmRoute)}`,
    };
  });

  pi.on("model_select", async (_event, ctx) => renderStatus(ctx));
  pi.on("thinking_level_select", async (_event, ctx) => renderStatus(ctx));

  pi.on("tool_execution_start", async (event, ctx) => {
    state.lastTool = event.toolName;
    state.lastToolError = undefined;
    renderStatus(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    state.lastTool = event.toolName;
    state.lastToolError = event.isError;
    renderStatus(ctx);
  });

  pi.registerCommand("reaper", {
    description: "Show Reaper cockpit commands and current status.",
    handler: async (_args, ctx) => {
      applyYoloTools(pi, ctx);
      pi.sendMessage(
        {
          customType: "reaper-cockpit-status",
          display: true,
          content: cockpitStatusText(ctx),
        },
        { triggerTurn: false },
      );
    },
  });

  registerWorkflowCommand(pi, "reaper-scout", "Read-only repo reconnaissance with concise JSON output.", "scout");
  registerWorkflowCommand(pi, "reaper-plan", "Turn a Reaper task into a concrete implementation plan.", "plan");
  registerWorkflowCommand(pi, "reaper-ship", "Run scout, plan, implement, test, review, and report.", "ship");
  registerWorkflowCommand(pi, "reaper-fix", "Bug-hunt workflow: reproduce, trace, patch, regression-test.", "fix");
  registerWorkflowCommand(pi, "reaper-review", "Review current changes with Reaper-specific criteria.", "review");
  registerWorkflowCommand(pi, "reaper-test", "Run targeted validation and summarize exact results.", "test");
  registerWorkflowCommand(pi, "reaper-bench", "Benchmark/eval workflow for Terminal-Bench/Reaper runs.", "bench");
  registerWorkflowCommand(pi, "reaper-failures", "Analyze recent failed Reaper runs/logs and propose general fixes.", "failure-analysis");
  registerWorkflowCommand(pi, "reaper-swarm", "Force swarm decomposition and parallel execution for a task.", "swarm");
  registerWorkflowCommand(pi, "reaper-status", "Inspect repo, task, and eval status without changing code.", "status");
}

function registerWorkflowCommand(pi: ExtensionAPI, name: string, description: string, mode: WorkflowMode): void {
  pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      applyYoloTools(pi, ctx);
      state.mode = mode;
      state.lastCommand = `/${name}${args ? ` ${args}` : ""}`;
      renderStatus(ctx);
      pi.sendUserMessage(buildWorkflowPrompt(mode, args || ""), { deliverAs: "followUp" });
    },
  });
}

function applyYoloTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (pi.getFlag("reaper-yolo") !== false) {
    pi.setActiveTools(pi.getAllTools().map((tool) => tool.name));
  }
  renderStatus(ctx);
}

function renderStatus(ctx: ExtensionContext): void {
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "model:unset";
  const thinking = ctx.model ? "" : "";
  const lastTool = state.lastTool
    ? ` last:${state.lastTool}${state.lastToolError === undefined ? "" : state.lastToolError ? ":err" : ":ok"}`
    : "";
  ctx.ui.setStatus("reaper-cockpit", `Reaper ${state.mode} YOLO swarm:${state.swarmRoute} ${model}${thinking}${lastTool}`);
}

function cockpitStatusText(ctx: ExtensionContext): string {
  const packageJson = readJson(join(ctx.cwd, "package.json"));
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object"
    ? Object.keys(packageJson.scripts as Record<string, unknown>).sort()
    : [];
  return [
    "**Reaper Pi Cockpit**",
    "",
    `Mode: ${state.mode}`,
    `Workspace: ${ctx.cwd}`,
    "Tools: all discovered tools (unrestricted YOLO active, no sandbox or cockpit permission gates)",
    `Automatic swarm route: ${state.swarmRoute}`,
    `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unset"}`,
    `Thinking: ${ctx.model ? ctx.model.reasoning ? "model supports reasoning" : "reasoning not advertised" : "unset"}`,
    `Last command: ${state.lastCommand ?? "none"}`,
    `Last tool: ${state.lastTool ?? "none"}${state.lastToolError === undefined ? "" : state.lastToolError ? " (error)" : " (ok)"}`,
    scripts.length ? `npm scripts: ${scripts.join(", ")}` : "npm scripts: unavailable",
    "",
    "Commands:",
    "- `/reaper-scout <task>`: scout files, modules, risks, tests",
    "- `/reaper-plan <task>`: produce a concrete implementation plan",
    "- `/reaper-ship <task>`: implement with tests and review",
    "- `/reaper-fix <bug/log>`: reproduce, trace, patch, regression-test",
    "- `/reaper-review <focus>`: review current diff",
    "- `/reaper-test <scope>`: run targeted checks",
    "- `/reaper-bench <scope>`: benchmark/eval workflow",
    "- `/reaper-failures <scope>`: analyze failed Reaper runs/logs",
    "- `/reaper-swarm <task>`: force swarm decomposition, isolated workers, review, and integration",
    "- `/reaper-status`: inspect repo/eval status",
  ].join("\n");
}

function buildWorkflowPrompt(mode: WorkflowMode, rawTask: string): string {
  const task = rawTask.trim() || "Inspect the current Reaper repository state and choose the next highest-impact action.";
  const shared = [
    "You are Pi acting as the Reaper development cockpit.",
    "Reaper is a TypeScript autonomous coding-agent harness. Optimize for fast, reliable development of Reaper itself.",
    `The trusted workspace root is ${process.cwd()}.`,
    "Unrestricted YOLO mode is active: every discovered Pi tool is available with no sandbox or cockpit permission gates.",
    "You are authorized to read, create, edit, replace, move, and delete workspace files and to execute shell commands, scripts, package managers, tests, and development tools inside the trusted workspace.",
    "Do not ask for routine permission before workspace operations. Ask only when required information is genuinely missing.",
    "Use the HyperAgent Opus provider and its structured Pi tool-call path for all workspace operations.",
    "Keep main-tree integration single-threaded. Parallel writes are allowed in the shared workspace when file leases are disjoint.",
    "Prefer concrete tool use over speculation. Inspect before editing. Run targeted tests when practical. Never fabricate test results.",
    "Final response must include: interpreted task, changed files, tests run, pass/fail status, remaining risks, next best step.",
  ];

  const modes: Record<WorkflowMode, string[]> = {
    scout: [
      "Mode: SCOUT.",
      "Read and search the repo to find relevant files, symbols, tests, configs, existing patterns, and risks.",
      "Do not edit unless the user explicitly asked for implementation inside this same prompt.",
      'Return a concise JSON scout report with keys: summary, relevant_files, important_symbols, existing_patterns, risks, recommended_next_step, confidence.',
    ],
    plan: [
      "Mode: PLAN.",
      "Inspect enough context to create a concrete implementation plan.",
      "Include state shape, affected modules, tests, rollout/rollback plan, and risks.",
      "Do not edit files unless the task explicitly asks to implement after planning.",
    ],
    ship: [
      "Mode: SHIP.",
      "Run the full loop: scout, plan, implement, targeted tests, diff review, and final report.",
      "Keep patches small and reviewable. Use existing Reaper patterns.",
      "If touching provider/tool/session/eval behavior, include a focused compatibility or regression check.",
    ],
    fix: [
      "Mode: BUG HUNT.",
      "Reproduce or inspect the failure first. Identify root cause from evidence, patch the smallest relevant surface, add or run a regression check, and review the diff.",
      "If logs are referenced, collect the newest relevant logs before proposing a fix.",
    ],
    review: [
      "Mode: REVIEW.",
      "Review current changes for bugs, regressions, missing tests, typing issues, performance risks, and Reaper agent-loop reliability.",
      "Do not edit unless the user explicitly asks for fixes.",
      "Lead with findings ordered by severity and include file/line references where possible.",
    ],
    test: [
      "Mode: TEST.",
      "Identify the narrowest useful checks for the requested scope, run them, and report exact commands and outcomes.",
      "Use npm scripts where appropriate, especially npm run typecheck and targeted node --import tsx --test tests/**/*.test.ts commands.",
    ],
    bench: [
      "Mode: BENCH.",
      "Inspect benchmark/eval scripts and recent results first. Run only the requested or smallest useful benchmark subset.",
      "Collect pass/fail counts, timeout/infra split, failed task IDs, and links/paths to logs.",
      "Do not delete benchmark artifacts unless explicitly requested.",
    ],
    "failure-analysis": [
      "Mode: FAILURE ANALYSIS.",
      "Collect recent failed Reaper logs/results, group failure patterns, identify generic agent fixes, and avoid task-specific patches.",
      "When implementing fixes, keep them language/task agnostic and add tests where possible.",
    ],
    swarm: [
      "Mode: SWARM.",
      "Use the Agent, get_subagent_result, and steer_subagent tools to execute the task as a controlled swarm.",
      "Start with swarm-scout decomposition. Launch independent swarm-workers concurrently in the shared workspace with non-overlapping file leases.",
      "Review worker branches, integrate passing branches into the main tree one at a time, then run integrated validation.",
      "If decomposition shows fewer than two independent units, fall back to direct execution instead of forcing useless parallelism.",
    ],
    status: [
      "Mode: STATUS.",
      "Inspect repository status, recent eval artifacts, running processes if relevant, and current Reaper task counts.",
      "Do not edit files. Return concise current-state facts and next action.",
    ],
  };

  return [...shared, ...modes[mode], "", `User task:\n${task}`].join("\n");
}

function classifySwarmRoute(prompt: string): SwarmRoute {
  const normalized = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return "direct";

  if (/\b(no|do not|don't|without)\s+(swarm|subagents?|parallel agents?)\b/.test(normalized)) {
    return "direct";
  }

  if (
    /\b(swarm|fan[- ]?out|parallel agents?|multiple agents?|use subagents?|agent orchestration)\b/.test(normalized)
  ) {
    return "forced";
  }

  let score = 0;
  const signals = [
    /\b(across|multiple|several|all)\s+(files?|modules?|packages?|tasks?|runs?|logs?|components?)\b/,
    /\b(multi[- ]file|large refactor|end[- ]to[- ]end|full suite|benchmark suite|failure patterns?)\b/,
    /\b(research|analy[sz]e|inspect|audit|review)\b.*\b(and|then)\b.*\b(implement|fix|update|compare)\b/,
    /\b(implement|fix|update|refactor)\b.*\b(and|plus)\b.*\b(test|review|document|benchmark)\b/,
    /\b(independent|non-overlapping|worktrees?|parallelizable)\b/,
  ];
  for (const signal of signals) {
    if (signal.test(normalized)) score += 1;
  }
  if (normalized.length >= 320) score += 1;
  if ((normalized.match(/\band\b/g) ?? []).length >= 3) score += 1;

  return score >= 1 ? "candidate" : "direct";
}

function buildAutoSwarmInstructions(route: Exclude<SwarmRoute, "direct">): string {
  return [
    "# Automatic Reaper Swarm Route",
    "",
    `Route: ${route}. The cockpit selected this task for swarm evaluation.`,
    "Use the Agent tool; do not merely describe a swarm.",
    "First inspect `git status --short`. Shared-workspace workers can see the current checkout, including uncommitted main-tree changes.",
    "Launch swarm-scout in the background to identify independent units, shared/hot files, dependencies, exact file leases, and verification commands. Continue useful parent-side preflight work while it runs instead of blocking immediately.",
    "If at least two units have non-overlapping leases and do not depend on relevant uncommitted changes, launch their swarm-workers concurrently in one turn with `run_in_background: true`.",
    "Use at most the configured concurrency. Poll with get_subagent_result and correct drift with steer_subagent.",
    "Run swarm-reviewer against each completed worker branch. Integrate only passing branches, one at a time, from the parent/main session.",
    "After integration, run the relevant combined tests and review the final main-tree diff.",
    "If safe parallel writes are not possible, still parallelize read-only scouting or independent checks, then perform writes directly and serially in the parent.",
    "Do not ask the user whether to use the swarm; make the routing decision and proceed.",
  ].join("\n");
}

function buildAutoSwarmUserDirective(route: Exclude<SwarmRoute, "direct">): string {
  return [
    `[REAPER_AUTO_SWARM_ROUTE:${route}]`,
    "The Reaper cockpit automatically selected this task for swarm evaluation.",
    "Your first tool call must be Agent with subagent_type `swarm-scout` and run_in_background `true` to decompose the original task into independent units, shared files, dependencies, and verification commands.",
    "Do not begin implementation before receiving the swarm-scout result; parent-side read-only preflight is allowed.",
    "After launching the background scout, continue useful orchestration/preflight work or launch additional independent read-only scouts; do not immediately block unless the result is required for the next action.",
    "After the scout result, launch parallel background swarm-workers in the shared workspace only for independent non-overlapping units. Otherwise continue directly.",
    "Do not ask the user whether to use the swarm.",
  ].join("\n");
}

function readJson(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
