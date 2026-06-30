import { readFile, writeFile } from "node:fs/promises";
import { normalizeWorkspacePath } from "../../policy/paths.js";
import { globalFileMutationQueue } from "./file-mutation-queue.js";

/**
 * Normalizes curly quotes to straight quotes for robust matching.
 */
function normalizeQuotes(str: string): string {
  return str
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"');
}

/**
 * When old_string matched via quote normalization (curly quotes in file,
 * straight quotes from model), apply the same curly quote style to new_string.
 */
function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  if (oldString === actualOldString) return newString;

  const hasDouble = actualOldString.includes("“") || actualOldString.includes("”");
  const hasSingle = actualOldString.includes("‘") || actualOldString.includes("’");
  if (!hasDouble && !hasSingle) return newString;

  let result = newString;
  if (hasDouble) {
    const chars = [...result];
    result = chars.map((c, i) => {
      if (c !== '"') return c;
      const isOpening = i === 0 || " \t\n\r([{".includes(chars[i - 1]!);
      return isOpening ? "“" : "”";
    }).join("");
  }
  if (hasSingle) {
    const chars = [...result];
    result = chars.map((c, i) => {
      if (c !== "'") return c;
      const isOpening = i === 0 || " \t\n\r([{".includes(chars[i - 1]!);
      return isOpening ? "‘" : "’";
    }).join("");
  }
  return result;
}

/**
 * Strips trailing whitespace from each line to handle LLM-induced drift.
 */
function stripTrailingWhitespace(str: string): string {
  return str.split(/\r?\n/).map(line => line.replace(/\s+$/, "")).join("\n");
}

/**
 * Finds the actual string in the file content that matches the search string,
 * accounting for quote and whitespace normalization.
 */
function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const normSearch = normalizeQuotes(stripTrailingWhitespace(searchString));
  const normFile = normalizeQuotes(stripTrailingWhitespace(fileContent));

  const index = normFile.indexOf(normSearch);
  if (index === -1) return null;

  // Since we normalized whitespace, we need to map back to original lines.
  // For simplicity, we assume exact character count if it matches.
  // Better yet, we can use a simpler heuristic for now.
  return null; // Fallback to exact if mapping is too complex
}

export async function editFileTool(
  workspaceRoot: string,
  args: { path: string; edits: Array<{ oldString: string; newString: string }> }
) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  return globalFileMutationQueue.run(filePath, async () => {
    const content = await readFile(filePath, "utf8");
    const applied = applyEditFileContent(content, args);
    await writeFile(filePath, applied.content, "utf8");
    return { path: filePath, appliedEdits: applied.appliedEdits, skippedAlreadyApplied: applied.skippedAlreadyApplied };
  });
}

export function applyEditFileContent(
  originalContent: string,
  args: { path: string; edits: Array<{ oldString: string; newString: string }> },
): { content: string; appliedEdits: number; skippedAlreadyApplied: number } {
  const planned: Array<{ start: number; end: number; actualOldString: string; oldString: string; newString: string }> = [];
  let skippedAlreadyApplied = 0;

  for (const edit of args.edits) {
    const { oldString, newString } = edit;
    const actualOldString = findLineEndingVariant(originalContent, oldString) ?? findQuoteNormalizedVariant(originalContent, oldString);
    if (!actualOldString) {
      if (newString && findLineEndingVariant(originalContent, newString)) {
        skippedAlreadyApplied++;
        continue;
      }
      throw new Error(
        `Block not found in file '${args.path}'. Re-read the file and retry using exact current text or a line-range replacement. ` +
        `If this edit was already applied, do not repeat it. Missing block:\n${oldString}`,
      );
    }

    const matches = allIndexesOf(originalContent, actualOldString);
    if (matches.length > 1) {
      throw new Error(
        `Multiple matches found for block in file '${args.path}'. Provide more surrounding context, use replace_in_file with ` +
        `startLine/endLine/content, or use replace_in_file with allowMultiple:true only when an intentional global replacement is safe.`,
      );
    }
    const start = matches[0];
    if (start === undefined) {
      throw new Error(`Block not found in file '${args.path}'.`);
    }
    planned.push({ start, end: start + actualOldString.length, actualOldString, oldString, newString });
  }

  planned.sort((a, b) => a.start - b.start);
  for (let index = 1; index < planned.length; index += 1) {
    const previous = planned[index - 1]!;
    const current = planned[index]!;
    if (current.start < previous.end) {
      throw new Error(`Multi-edit ranges overlap in file '${args.path}'. Re-read and provide non-overlapping exact edits.`);
    }
  }

  let content = originalContent;
  for (const edit of [...planned].reverse()) {
    const appliedNewString = normalizeReplacementLineEndings(preserveQuoteStyle(edit.oldString, edit.actualOldString, edit.newString), edit.actualOldString);
    content = `${content.slice(0, edit.start)}${appliedNewString}${content.slice(edit.end)}`;
  }

  return { content, appliedEdits: planned.length, skippedAlreadyApplied };
}

function findLineEndingVariant(content: string, oldString: string): string | null {
  const variants = [
    oldString,
    oldString.replace(/\r?\n/g, "\r\n"),
    oldString.replace(/\r\n/g, "\n"),
  ];
  const seen = new Set<string>();
  for (const variant of variants) {
    if (seen.has(variant)) continue;
    seen.add(variant);
    if (content.includes(variant)) return variant;
  }
  return null;
}

function findQuoteNormalizedVariant(content: string, oldString: string): string | null {
  const normOld = normalizeQuotes(oldString.trim());
  const normContent = normalizeQuotes(content);
  const index = normContent.indexOf(normOld);
  if (index === -1) return null;
  const candidate = content.substring(index, index + oldString.length);
  return normalizeQuotes(candidate.trim()) === normOld ? candidate : null;
}

function allIndexesOf(content: string, search: string): number[] {
  if (search.length === 0) return [];
  const indexes: number[] = [];
  let start = 0;
  while (true) {
    const index = content.indexOf(search, start);
    if (index === -1) return indexes;
    indexes.push(index);
    start = index + search.length;
  }
}

function normalizeReplacementLineEndings(newString: string, actualOldString: string): string {
  return actualOldString.includes("\r\n") ? newString.replace(/\r?\n/g, "\r\n") : newString;
}
