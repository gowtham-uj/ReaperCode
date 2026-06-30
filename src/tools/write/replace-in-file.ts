import { readFile, writeFile } from "node:fs/promises";

import { normalizeWorkspacePath } from "../../policy/paths.js";
import { globalFileMutationQueue } from "./file-mutation-queue.js";

export async function replaceInFileTool(
  workspaceRoot: string,
  args:
    | { path: string; oldString: string; newString: string; allowMultiple?: boolean | undefined }
    | { path: string; startLine: number; endLine: number; content: string },
) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  return globalFileMutationQueue.run(filePath, async () => {
    const content = await readFile(filePath, "utf8");

    if ("startLine" in args) {
      const { next, endLine } = replaceLineRange(content, args.startLine, args.endLine, args.content, args.path);
      await writeFile(filePath, next, "utf8");
      return { path: filePath, startLine: args.startLine, endLine, replacements: 1 };
    }

    const { next, replacements } = replaceExactString(content, args.oldString, args.newString, args.allowMultiple ?? false, args.path);
    await writeFile(filePath, next, "utf8");
    return { path: filePath, replacements };
  });
}

export function replaceExactString(
  content: string,
  oldString: string,
  newString: string,
  allowMultiple: boolean,
  targetPath: string,
): { next: string; replacements: number } {
  const match = findExactOrLineEndingVariant(content, oldString);
  if (!match) {
    throw new Error(
      [
        `String not found in file '${targetPath}'.`,
        "This usually means the file changed after the oldString was chosen, indentation/quoting differs, or the block was already edited.",
        "Do not repeat the same oldString unchanged. Read the current target region with read_file and retry using exact current text, or use replace_in_file with startLine/endLine/content for the smallest safe region.",
        `Missing oldString preview:\n${oldString.slice(0, 1200)}`,
      ].join("\n"),
    );
  }

  const matches = content.split(match.actualOldString).length - 1;
  if (matches > 1 && !allowMultiple) {
    throw new Error(`Multiple matches found in file '${targetPath}'`);
  }

  const replacement = match.usesCrlf ? newString.replace(/\r?\n/g, "\r\n") : newString;
  const next = allowMultiple ? content.split(match.actualOldString).join(replacement) : content.replace(match.actualOldString, replacement);
  return { next, replacements: allowMultiple ? matches : 1 };
}

function findExactOrLineEndingVariant(content: string, oldString: string): { actualOldString: string; usesCrlf: boolean } | undefined {
  const variants = [
    oldString,
    oldString.replace(/\r?\n/g, "\r\n"),
    oldString.replace(/\r\n/g, "\n"),
  ];
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant)) continue;
    seen.add(variant);
    if (content.includes(variant)) {
      return { actualOldString: variant, usesCrlf: variant.includes("\r\n") };
    }
  }
  return undefined;
}

export function replaceLineRange(
  content: string,
  startLine: number,
  endLine: number,
  replacement: string,
  targetPath: string,
): { next: string; endLine: number } {
  if (endLine < startLine) {
    throw new Error(`Invalid line range for '${targetPath}': endLine must be greater than or equal to startLine`);
  }
  const hasFinalNewline = content.endsWith("\n");
  const lines = content.split(/\n/);
  if (hasFinalNewline) lines.pop();
  if (startLine > lines.length + 1) {
    throw new Error(`Invalid line range for '${targetPath}': startLine ${startLine} is beyond file length ${lines.length}`);
  }
  if (endLine > lines.length) {
    endLine = lines.length;
  }
  const replacementLines = replacement.endsWith("\n") ? replacement.slice(0, -1).split(/\n/) : replacement.split(/\n/);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  const next = lines.join("\n");
  return { next: hasFinalNewline || replacement.endsWith("\n") ? `${next}\n` : next, endLine };
}
