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

/** Head+tail options for `buildBashResultOutput`. */
export interface BashHeadTailOptions {
  bashHeadTailEnabled?: boolean;
  bashHeadPreviewChars?: number;
  bashTailPreviewChars?: number;
}

export async function buildBashResultOutput(
  input: BashInput,
  base: BashOutput,
  workspaceRoot: string,
  headTailOptions: BashHeadTailOptions = {},
): Promise<ModelFacingResult> {
  let stdout = base.stdout;
  let stderr = base.stderr;

  const headTailEnabled =
    headTailOptions.bashHeadTailEnabled ?? true;
  const headChars =
    headTailOptions.bashHeadPreviewChars ?? 1_200;
  const tailChars =
    headTailOptions.bashTailPreviewChars ?? 1_200;

  // Only truncate if output was ACTUALLY persisted due to size,
  // not just because a process log file exists.
  // The persisted_output_path is set for every command (process logging),
  // but persisted_output_size > 0 combined with stdout exceeding the
  // PERSIST_THRESHOLD means the output was too large to return inline.
  if (base.persisted_output_path && base.persisted_output_size && base.persisted_output_size > BASH_INPUT_DEFAULTS.PERSIST_THRESHOLD_CHARS && stdout.length > BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) {
    if (headTailEnabled) {
      // Keep the first N and last N chars; the middle is persisted to disk.
      const head = stdout.slice(0, headChars);
      const tail = stdout.length > headChars + tailChars ? stdout.slice(-tailChars) : "";
      const middleBytes = base.persisted_output_size - headChars - tail.length;
      stdout =
        head +
        `\n\n... ${middleBytes} chars truncated, full output persisted to ${base.persisted_output_path} (head_available=true, tail_available=${tail.length > 0}) ...\n\n` +
        tail;
    } else {
      stdout = stdout.slice(0, BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS) +
        `\n\n... output persisted to ${base.persisted_output_path} (${base.persisted_output_size ?? "unknown"} bytes) ...\n`;
    }
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
  /*
   * The pointer the model is given must name the file that holds everything.
   *
   * It used to name `persisted_output_path`, and to call it "full output". That
   * file is written from an in-memory buffer capped at 256KB, so on a large
   * command it holds a fraction of the output — 0.62% of a 42MB `cat` — while
   * the complete stream sits in the run's process log. A model that believed
   * the notice would analyse the tail of a log and draw conclusions about all
   * of it.
   *
   * `full_output_path` is that process log, set by `execute.ts` from the shell
   * result. When it is absent the output never exceeded the buffer and
   * `persisted_output_path` really is the whole thing, so each branch names the
   * file it can honestly claim.
   */
  /*
   * Both spellings are read, and that is not defensive programming.
   *
   * The tool's own schema names these fields in snake_case, while the executor's
   * bash case returns a `ForegroundShellResult` in camelCase and never runs the
   * snake_case conversion. The result therefore carries `fullOutputPath` on one
   * path and `full_output_path` on the other, and a reader that only checked one
   * spelling would silently fall back to the bounded artifact — the exact bug
   * this field exists to fix. Which casing arrives depends on the caller, so
   * both are accepted.
   */
  const extended = base as BashOutput & { fullOutputPath?: string; fullOutputSize?: number };
  const completePath = base.full_output_path ?? extended.fullOutputPath ?? base.persisted_output_path;
  const completeSize = base.full_output_size ?? extended.fullOutputSize ?? base.persisted_output_size;
  const completeIsFullOutput =
    Boolean(base.full_output_path ?? extended.fullOutputPath);
  if (
    completePath &&
    completeSize &&
    completeSize > BASH_INPUT_DEFAULTS.PERSIST_THRESHOLD_CHARS
  ) {
    const sizeNote =
      completeIsFullOutput && base.persisted_output_path && completePath !== base.persisted_output_path
        // Both exist and differ, so say which is which rather than leaving the
        // reader to guess why there are two paths.
        ? ` (complete; the inline preview above and ${base.persisted_output_path} hold only the newest part)`
        : "";
    text += `\n\n[Full output written to ${completePath}${sizeNote}]`;
  }

  const trust = classifyToolResultTrust({ name: "bash", args: { cmd: input.command } });
  if (trust === "untrusted") {
    text = wrapUntrustedContent(text, `bash: ${input.command}`);
  }

  return { content: text, output: base };
}

export async function persistBashOutput(
  stdout: string,
  stderr: string,
  workspaceRoot: string,
  previewOptions: { headChars?: number; tailChars?: number } = {},
): Promise<{
  stdout: string;
  stderr: string;
  persistedOutputPath: string;
  persistedOutputSize: number;
  headAvailable: boolean;
  tailAvailable: boolean;
}> {
  const combined = `=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}`;
  const artifactId = randomUUID();
  const dir = path.join(workspaceRoot, ".reaper", "artifacts", "bash");
  await mkdir(dir, { recursive: true });
  const artifactPath = path.join(dir, `${artifactId}.txt`);
  await writeFile(artifactPath, combined, "utf8");

  // Keep BOTH head and tail in the inline preview so needles in either
  // end of giant logs remain visible (A/B finding: tail-only lost head needles).
  const headChars = previewOptions.headChars ?? BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS;
  const tailChars = previewOptions.tailChars ?? BASH_INPUT_DEFAULTS.PREVIEW_SIZE_CHARS;
  let preview: string;
  let headAvailable = false;
  let tailAvailable = false;
  if (stdout.length <= headChars + tailChars) {
    preview = stdout || stderr.slice(0, headChars) || "(output persisted)";
    headAvailable = stdout.length > 0;
  } else {
    const head = stdout.slice(0, headChars);
    const tail = stdout.slice(-tailChars);
    preview =
      head +
      `\n\n... ${stdout.length - headChars - tailChars} chars truncated; full output at ${artifactPath} ...\n\n` +
      tail;
    headAvailable = true;
    tailAvailable = true;
  }

  return {
    stdout: preview,
    stderr: "",
    persistedOutputPath: artifactPath,
    persistedOutputSize: Buffer.byteLength(combined, "utf8"),
    headAvailable,
    tailAvailable,
  };
}

export function getActivityDescription(input: BashInput): string {
  return input.description ?? input.command;
}
