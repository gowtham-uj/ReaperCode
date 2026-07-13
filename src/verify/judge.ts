import { generateStructuredJson } from "../model/json-response.js";
import type { ModelGateway, ModelRole } from "../model/types.js";
import { normalizeToolCall } from "../tools/normalize.js";
import { ToolCallSchema, type ToolCall } from "../tools/types.js";
import type { ClassifiedVerificationFailure } from "./failure-classifier.js";

export interface JudgeResult {
  feedback: string;
  negativeConstraints: string[];
  toolCalls: ToolCall[];
}

export interface SelfDebugExplanationResult {
  ok: boolean;
  explanation: string;
  discrepancies: string[];
}

export async function runVerificationJudge(input: {
  modelGateway: ModelGateway;
  role?: ModelRole;
  prompt: string;
  verificationCommand: string;
  failureOutput: string;
  classification?: ClassifiedVerificationFailure;
  contextChunks: Array<{ path: string; content: string }>;
}): Promise<JudgeResult> {
  const parsed = await generateStructuredJson({
    modelGateway: input.modelGateway,
    role: input.role ?? "judge",
    messages: [
      {
        role: "user",
        content:
          `You are the verification judge for Reaper. ` +
          `Return strict JSON with shape {"feedback": string, "negativeConstraints": string[], "toolCalls": ToolCall[]}. ` +
          `Available tool names: read_file, list_directory, grep_search, write_file, replace_in_file, delete_file, bash. ` +
          `Task prompt: ${input.prompt}. ` +
          `Verification command: ${input.verificationCommand}. ` +
          `Failure classification: ${JSON.stringify(input.classification ?? null)}. ` +
          `Failure output: ${input.failureOutput}. ` +
          `Relevant context: ${JSON.stringify(input.contextChunks.map((chunk) => ({ path: chunk.path, preview: chunk.content.slice(0, 1200) })))}. ` +
          `Before choosing edits, reason from the whole failure cluster: missing scripts, missing dependencies, type config, test discovery, and runtime assertions may need to be fixed together. ` +
          `Do not hardcode a stack-specific answer. Preserve the implementation choices already present unless the failure proves they are incoherent. ` +
          `Only propose tool calls that directly address the failure, but batch related manifest/config/source fixes so verification does not discover one missing piece at a time.`,
      },
    ],
    parse: (value) =>
      value as {
        feedback?: unknown;
        negativeConstraints?: unknown;
        toolCalls?: unknown[];
      },
  });

  return {
    feedback: typeof parsed.feedback === "string" ? parsed.feedback : "Verification judge produced no feedback.",
    negativeConstraints: Array.isArray(parsed.negativeConstraints)
      ? parsed.negativeConstraints.filter((item): item is string => typeof item === "string")
      : [],
    toolCalls: Array.isArray(parsed.toolCalls)
      ? parsed.toolCalls.flatMap((call) => {
          const result = ToolCallSchema.safeParse(normalizeToolCall(call));
          return result.success ? [result.data] : [];
        })
      : [],
  };
}

export async function runSelfDebugExplanation(input: {
  modelGateway: ModelGateway;
  role?: ModelRole;
  prompt: string;
  completionSummary: string;
  verificationCommand: string;
  verificationOutput: string;
}): Promise<SelfDebugExplanationResult> {
  const parsed = await generateStructuredJson({
    modelGateway: input.modelGateway,
    role: input.role ?? "judge",
    messages: [
      {
        role: "user",
        content:
          `You are reviewing whether a task completion actually satisfies the task. ` +
          `Return strict JSON with shape {"ok": boolean, "explanation": string, "discrepancies": string[]}. ` +
          `Task prompt: ${input.prompt}. ` +
          `Completion summary: ${input.completionSummary}. ` +
          `Grounded verification command: ${input.verificationCommand}. ` +
          `Verification output: ${input.verificationOutput.slice(0, 8000)}. ` +
          `Explain the completed change against the task requirements. If any requirement is missing, inconsistent, or only self-reported without evidence, include it in discrepancies.`,
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
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    discrepancies,
  };
}
