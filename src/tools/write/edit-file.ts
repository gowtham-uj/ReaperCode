import { readFile, writeFile } from "node:fs/promises";
import { normalizeWorkspacePath } from "../../policy/paths.js";

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
  const content = await readFile(filePath, "utf8");
  const applied = applyEditFileContent(content, args);
  await writeFile(filePath, applied.content, "utf8");
  return { path: filePath, appliedEdits: applied.appliedEdits, skippedAlreadyApplied: applied.skippedAlreadyApplied };
}

export function applyEditFileContent(
  originalContent: string,
  args: { path: string; edits: Array<{ oldString: string; newString: string }> },
): { content: string; appliedEdits: number; skippedAlreadyApplied: number } {
  let content = originalContent;
  let appliedEdits = 0;
  let skippedAlreadyApplied = 0;

  for (const edit of args.edits) {
    const { oldString, newString } = edit;
    
    // 1. Try exact match, including line-ending variants because read_file presents
    // normalized lines while legacy files may use CRLF on disk.
    let actualOldString: string | null = findLineEndingVariant(content, oldString);
    
    // 2. Try normalized match if exact fails
    if (!actualOldString) {
      const normOld = normalizeQuotes(oldString.trim());
      const normContent = normalizeQuotes(content);
      
      // If the trimmed version matches (ignoring leading/trailing empty lines)
      if (normContent.includes(normOld)) {
        // We find the index and try to extract the original chunk
        // This is tricky due to character mapping. 
        // For now, we only support exact matches or simple quote-normalized matches.
        const index = normContent.indexOf(normOld);
        actualOldString = content.substring(index, index + oldString.length);
        
        // Verify it actually matches when normalized
        if (normalizeQuotes(actualOldString.trim()) !== normOld) {
          actualOldString = null;
        }
      }
    }

    if (!actualOldString) {
      if (newString && findLineEndingVariant(content, newString)) {
        skippedAlreadyApplied++;
        continue;
      }
      throw new Error(
        `Block not found in file '${args.path}'. Re-read the file and retry using exact current text or a line-range replacement. ` +
        `If this edit was already applied, do not repeat it. Missing block:\n${oldString}`,
      );
    }

    const matches = content.split(actualOldString).length - 1;
    if (matches > 1) {
      throw new Error(
        `Multiple matches found for block in file '${args.path}'. Provide more surrounding context, use replace_in_file with ` +
        `startLine/endLine/content, or use replace_in_file with allowMultiple:true only when an intentional global replacement is safe.`,
      );
    }

    const appliedNewString = normalizeReplacementLineEndings(preserveQuoteStyle(oldString, actualOldString, newString), actualOldString);
    content = content.replace(actualOldString, appliedNewString);
    appliedEdits++;
  }

  return { content, appliedEdits, skippedAlreadyApplied };
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

function normalizeReplacementLineEndings(newString: string, actualOldString: string): string {
  return actualOldString.includes("\r\n") ? newString.replace(/\r?\n/g, "\r\n") : newString;
}
