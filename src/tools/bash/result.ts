import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { classifyToolResultTrust, wrapUntrustedContent } from "../../context/trust.js";
import { BASH_INPUT_DEFAULTS } from "./constants.js";
import type { BashInput, BashOutput } from "./schema.js";

export interface ModelFacingResult {
  content: string;
  output: BashOutput;
}

export async function buildBashResultOutput(
  input: BashInput,
  base: BashOutput,
  workspaceRoot: string,
): Promise<ModelFacingResult> {
  let stdout = base.stdout;
  let stderr = base.stderr;

  // Only truncate if output was ACTUALLY persisted due to size,
  // not just because a process log file exists.
  // The persisted_output_path is set for every command (process logging),
  // but persisted_output_size > 0 combined with stdout exceeding the
  // PERSIST_THRESHOLD means the output was too large to return inline.
  if (base.persisted_output_path && base.persisted_output_size && base.persisted_output_size > BASH_INPUT_DEFAULTS.PERSIST_THRESHOLD_CHARS && stdout.length > BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) {
    stdout = stdout.slice(0, BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) +
      `\n\n... output persisted to ${base.persisted_output_path} (${base.persisted_output_size ?? "unknown"} bytes) ...\n`;
    stderr = stderr.slice(0, BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) || "";
  }

  let text = "";
  if (base.exit_code !== 0 && !base.interrupted) {
    text = `Command exited with code ${base.exit_code}.\n`;
  }
  if (base.interrupted) {
    text += "[Command was aborted before completion]\n";
  }
  text += stdout;
  if (stderr) {
    text += `\n\nstderr:\n${stderr}`;
  }
  // Only show the "Full output written to" notice if the output was
  // actually persisted due to size (not just process logging).
  if (base.persisted_output_path && base.persisted_output_size && base.persisted_output_size > BASH_INPUT_DEFAULTS.PERSIST_THRESHOLD_CHARS) {
    text += `\n\n[Full output written to ${base.persisted_output_path}]`;
  }

  const trust = classifyToolResultTrust({ name: "bash", args: { cmd: input.command } });
  if (trust === "untrusted") {
    text = wrapUntrustedContent(text, `run_shell_command: ${input.command}`);
  }

  return { content: text, output: base };
}

export async function persistBashOutput(
  stdout: string,
  stderr: string,
  workspaceRoot: string,
): Promise<{ stdout: string; stderr: string; persistedOutputPath: string; persistedOutputSize: number }> {
  const combined = `=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}`;
  const artifactId = randomUUID();
  const dir = path.join(workspaceRoot, ".reaper", "artifacts", "bash");
  await mkdir(dir, { recursive: true });
  const artifactPath = path.join(dir, `${artifactId}.txt`);
  await writeFile(artifactPath, combined, "utf8");
  const preview = stdout.slice(0, BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) ||
    stderr.slice(0, BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) ||
    "(output persisted)";
  return { stdout: preview, stderr: "", persistedOutputPath: artifactPath, persistedOutputSize: Buffer.byteLength(combined, "utf8") };
}

export function getActivityDescription(input: BashInput): string {
  return input.description ?? input.command;
}
