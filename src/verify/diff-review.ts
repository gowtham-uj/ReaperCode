import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { generateStructuredJson } from "../model/json-response.js";
import type { ModelGateway, ModelRole } from "../model/types.js";

const execFileAsync = promisify(execFile);

export interface FreshContextDiffReviewResult {
  ok: boolean;
  diffReviewed: boolean;
  explanation: string;
  discrepancies: string[];
}

export async function collectWorkspaceDiff(workspaceRoot: string, maxChars = 12_000): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", workspaceRoot, "diff", "--no-ext-diff", "--", "."], {
      timeout: 5_000,
      maxBuffer: Math.max(maxChars * 2, 1024 * 1024),
    });
    const diff = String(result.stdout ?? "").trim();
    if (diff) return truncateMiddle(diff, maxChars);
  } catch {
    return "";
  }
  return "";
}

export async function runFreshContextDiffReview(input: {
  modelGateway: ModelGateway;
  role?: ModelRole;
  prompt: string;
  completionSummary: string;
  verificationCommand: string;
  verificationOutput: string;
  diff: string;
}): Promise<FreshContextDiffReviewResult> {
  const diff = input.diff.trim();
  if (!diff) {
    return {
      ok: true,
      diffReviewed: false,
      explanation: "No workspace diff was available for fresh-context review.",
      discrepancies: [],
    };
  }

  const parsed = await generateStructuredJson({
    modelGateway: input.modelGateway,
    role: input.role ?? "judge",
    maxTokens: 2048,
    messages: [
      {
        role: "user",
        content:
          `You are a fresh-context reviewer for an autonomous coding agent. ` +
          `Return strict JSON with shape {"ok": boolean, "explanation": string, "discrepancies": string[]}. ` +
          `Review only whether the diff satisfies the task and whether the verification evidence is relevant. ` +
          `Do not request unrelated refactors or style changes. Mark ok=false for missing requested behavior, suspicious hardcoding, edits unrelated to the task, or verification that does not exercise the changed behavior. ` +
          `Task prompt: ${input.prompt}. ` +
          `Completion summary: ${input.completionSummary}. ` +
          `Grounded verification command: ${input.verificationCommand}. ` +
          `Verification output: ${input.verificationOutput.slice(0, 6000)}. ` +
          `Workspace diff:\n${diff}`,
      },
    ],
    parse: (value) =>
      value as {
        ok?: unknown;
        explanation?: unknown;
        discrepancies?: unknown[];
      },
  });

  const discrepancies = Array.isArray(parsed.discrepancies)
    ? parsed.discrepancies.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  return {
    ok: parsed.ok === true && discrepancies.length === 0,
    diffReviewed: true,
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    discrepancies,
  };
}

function truncateMiddle(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const head = Math.ceil(maxChars / 2);
  const tail = Math.floor(maxChars / 2);
  return `${input.slice(0, head)}\n...[diff truncated]...\n${input.slice(-tail)}`;
}
