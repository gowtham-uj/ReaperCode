import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getReaperScratchpadPaths } from "../workspace/scratchpad.js";

export interface StoredArtifact {
  artifactId: string;
  kind: "tool_output" | "verification_log" | "attachment";
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export class ArtifactStore {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(workspaceRoot: string) {
    this.root = getReaperScratchpadPaths(workspaceRoot).artifacts;
    this.indexPath = path.join(this.root, "index.json");
  }

  async put(kind: StoredArtifact["kind"], content: string): Promise<StoredArtifact> {
    await mkdir(this.root, { recursive: true });
    const artifactId = randomUUID();
    const filePath = path.join(this.root, `${artifactId}.txt`);
    await writeFile(filePath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifact: StoredArtifact = { artifactId, kind, path: filePath, bytes, sha256, createdAt: new Date().toISOString() };
    const index = await this.readIndex();
    index.push(artifact);
    await writeFile(this.indexPath, JSON.stringify(index, null, 2), "utf8");
    return artifact;
  }

  async get(artifactId: string): Promise<StoredArtifact & { content: string }> {
    const index = await this.readIndex();
    const artifact = index.find((item) => item.artifactId === artifactId);
    if (!artifact) {
      throw new Error(`Artifact '${artifactId}' not found`);
    }
    const content = await readFile(artifact.path, "utf8");
    return { ...artifact, content };
  }

  async pruneOlderThan(maxAgeMs: number): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    const index = await this.readIndex();
    const kept: StoredArtifact[] = [];
    for (const artifact of index) {
      if (new Date(artifact.createdAt).getTime() < cutoff) {
        await rm(artifact.path, { force: true }).catch(() => undefined);
      } else {
        kept.push(artifact);
      }
    }
    await mkdir(this.root, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(kept, null, 2), "utf8");
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const index = await this.readIndex();
    let bytes = 0;
    for (const artifact of index) {
      try {
        bytes += (await stat(artifact.path)).size;
      } catch {
        continue;
      }
    }
    return { count: index.length, bytes };
  }

  private async readIndex(): Promise<StoredArtifact[]> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as StoredArtifact[];
    } catch {
      return [];
    }
  }
}
