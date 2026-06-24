import type { ArtifactStore } from "../../artifacts/store.js";

export async function getToolOutputTool(store: ArtifactStore, args: { artifactId: string }) {
  return store.get(args.artifactId);
}
