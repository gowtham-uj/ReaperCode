import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface LogIndexEntry {
  event_id: string;
  offset: number;
}

export class LogIndexFile {
  private readonly filePath: string;

  constructor(workspaceRoot: string, filename: string, runId?: string) {
    const scratchpad = getReaperScratchpadPaths(workspaceRoot);
    this.filePath = path.join(runId ? path.join(scratchpad.runs, runId, "logs") : scratchpad.logs, filename);
  }

  async append(entry: LogIndexEntry): Promise<void> {
    const current = await this.readAll();
    current.push(entry);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(current, null, 2), "utf8");
  }

  async readAll(): Promise<LogIndexEntry[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as LogIndexEntry[];
    } catch {
      return [];
    }
  }

  get path() {
    return this.filePath;
  }
}
