import { readFile, writeFile } from "node:fs/promises";

import { extractFileGraphNode } from "../../context/graph.js";
import { normalizeWorkspacePath } from "../../policy/paths.js";

export async function replaceSymbolTool(
  workspaceRoot: string,
  args: { path: string; symbolName: string; newCode: string },
) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  const content = await readFile(filePath, "utf8");
  const node = extractFileGraphNode(
    {
      path: filePath,
      relativePath: args.path,
      sizeBytes: Buffer.byteLength(content, "utf8"),
      modifiedMs: Date.now(),
    },
    content,
  );

  const symbol = node.symbols.find((entry) => entry.name === args.symbolName);
  if (!symbol) {
    throw new Error(`Symbol '${args.symbolName}' not found in current AST`);
  }

  const newCode = normalizeReplacementCode(content, symbol.startIndex, args.newCode);
  const next = `${content.slice(0, symbol.startIndex)}${newCode}${content.slice(symbol.endIndex)}`;
  await writeFile(filePath, next, "utf8");
  return { path: filePath, symbolName: args.symbolName, replaced: true };
}

function normalizeReplacementCode(content: string, startIndex: number, newCode: string): string {
  const prefix = content.slice(Math.max(0, startIndex - 16), startIndex);
  if (/\bexport\s+$/.test(prefix) && /^export\s+/.test(newCode)) {
    return newCode.replace(/^export\s+/, "");
  }
  return newCode;
}
