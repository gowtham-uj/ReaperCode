import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWorkspacePath } from "../../policy/paths.js";
import { globalFileMutationQueue } from "./file-mutation-queue.js";

export async function writeFileTool(workspaceRoot: string, args: { path: string; content: string }) {
  const filePath = normalizeWorkspacePath(workspaceRoot, args.path);
  const existing = await stat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (existing?.isDirectory()) {
    throw new Error(`write_file target '${args.path}' is a directory. Use a concrete file path such as '${path.posix.join(args.path, "index.js")}', or use bash for shell commands.`);
  }
  return globalFileMutationQueue.run(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, args.content, "utf8");
    return { path: filePath, bytesWritten: Buffer.byteLength(args.content, "utf8") };
  });
}
