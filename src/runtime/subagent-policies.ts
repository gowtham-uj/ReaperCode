import type {SubagentType} from "./subagent-state.js";

export type SubagentPolicy = {
  type: SubagentType;
  /** Human-readable purpose of the subagent. */
  purpose: string;
  /** Whether the subagent may mutate files. */
  mayMutateFiles: boolean;
  /** Whether the subagent may emit executable tool calls. */
  mayEmitToolCalls: boolean;
  /** Whether the subagent can approve or complete the task on its own. */
  canApproveTask: boolean;
  /** Guidance for the subagent's output. */
  outputDescription: string;
  /** Concrete JSON shape hint to include in prompts. */
  outputShape: string;
  /** Extra behavioral rules, e.g. reviewer can run commands. */
  rules: string[];
};

export const SUBAGENT_POLICIES: Record<SubagentType, SubagentPolicy> = {
  planner: {
    type: "planner",
    purpose: "propose a candidate plan or decomposition",
    mayMutateFiles: false,
    mayEmitToolCalls: false,
    canApproveTask: false,
    outputDescription: "A candidate plan that main agent must explicitly apply via update_plan.",
    outputShape: '{ "plan": "markdown plan", "steps": ["..."], "rationale": "..." }',
    rules: [
      "Plans are advisory. Do not apply them directly.",
      "The main agent owns all decisions; suggestions must be concise and evidence-based.",
    ],
  },
  reviewer: {
    type: "reviewer",
    purpose: "review changes or proposed changes and produce a verdict",
    mayMutateFiles: false,
    mayEmitToolCalls: false,
    canApproveTask: true,
    outputDescription: "A review verdict that influences completion eligibility.",
    outputShape: '{ "verdict": "approved" | "request_changes" | "block", "evidence": "...", "items": [...] }',
    rules: [
      "You may base the verdict on files read by the main agent, current diff, or allowlisted verification commands you were asked to run.",
      "A 'block' verdict should be reserved for correctness, security, or contract-violating issues.",
      "The main agent can choose to fix your concerns and then proceed; you are a gate, not a replacement for verification commands.",
    ],
  },
  repair: {
    type: "repair",
    purpose: "suggest a focused fix for a specific problem",
    mayMutateFiles: false,
    mayEmitToolCalls: false,
    canApproveTask: false,
    outputDescription: "A recommended patch or diagnosis.",
    outputShape: '{ "diagnosis": "...", "patch": { "path": "...", "search": "...", "replace": "..." } }',
    rules: [
      "Do not write files. Recommend concrete edits the main agent can apply.",
      "If the problem cannot be isolated, explain what additional diagnostics are needed.",
    ],
  },
  tester: {
    type: "tester",
    purpose: "propose a test strategy and interpret results",
    mayMutateFiles: false,
    mayEmitToolCalls: false,
    canApproveTask: false,
    outputDescription: "A test strategy and pass/fail assessment based on evidence.",
    outputShape: '{ "strategy": "...", "commands": ["..."], "assessment": "pass" | "fail" | "needs_more_tests", "evidence": "..." }',
    rules: [
      "Do not install dependencies or mutate files without main-agent approval.",
      "Only declare 'pass' when commands with strict command-backed evidence indicate success.",
    ],
  },
  researcher: {
    type: "researcher",
    purpose: "read-only research and synthesis",
    mayMutateFiles: false,
    mayEmitToolCalls: false,
    canApproveTask: false,
    outputDescription: "A concise summary of findings.",
    outputShape: '{ "summary": "...", "sources": [...], "risks": [...] }',
    rules: ["Do not modify files, registries, or graph routing.", "Cite the files or excerpts that support each claim."],
  },
};

export function getSubagentPolicy(type: SubagentType): SubagentPolicy {
  return SUBAGENT_POLICIES[type];
}

export function renderSubagentPolicy(type: SubagentType): string {
  const p = SUBAGENT_POLICIES[type];
  return [
    `Policy for ${type} subagent:`,
    `- Purpose: ${p.purpose}`,
    `- May mutate files: ${p.mayMutateFiles ? "yes" : "no"}`,
    `- May emit executable tool calls: ${p.mayEmitToolCalls ? "yes" : "no"}`,
    `- Can approve task on its own: ${p.canApproveTask ? "yes" : "no"}`,
    `- Output: ${p.outputDescription}`,
    `- Expected JSON shape: ${p.outputShape}`,
    ...p.rules.map((rule) => `- ${rule}`),
  ].join("\n");
}
