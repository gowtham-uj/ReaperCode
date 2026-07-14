import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolExecutor } from "../../../src/tools/executor.js";
import type { ToolCall } from "../../../src/tools/types.js";
import { FileViewResultSchema } from "../../../src/tools/viewer/types.js";

function buildExecutor(workspaceRoot: string): ToolExecutor {
  return new ToolExecutor({
    workspaceRoot,
    runId: "observation-metadata-run",
    sessionId: "observation-metadata-session",
    traceId: "observation-metadata-trace",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

function viewerCall(name: "file_view" | "file_scroll", args: Record<string, unknown>): ToolCall {
  const runtimeViewerCall = { id: randomUUID(), name, args };
  // Viewer calls are deliberately intercepted before the legacy ToolCall union switch.
  return runtimeViewerCall as unknown as ToolCall;
}

function requireLegacyReadMetadata(output: unknown): { sha256: string; mtimeMs: number } {
  if (
    typeof output !== "object" ||
    output === null ||
    !("sha256" in output) ||
    typeof output.sha256 !== "string" ||
    !("mtimeMs" in output) ||
    typeof output.mtimeMs !== "number"
  ) {
    throw new Error("expected read_file/view_file freshness metadata");
  }
  return { sha256: output.sha256, mtimeMs: output.mtimeMs };
}

test("viewer and legacy read results expose one strict freshness shape", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "reaper-observation-metadata-"));
  try {
    const content = "alpha\nbeta\ngamma\n";
    await writeFile(path.join(workspaceRoot, "sample.txt"), content, "utf8");
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const executor = buildExecutor(workspaceRoot);

    const viewed = await executor.execute(viewerCall("file_view", {
      path: "sample.txt",
      start_line: 1,
      window: 2,
    }));
    assert.equal(viewed.ok, true);
    assert.ok(typeof viewed.output === "string");
    const viewResult = FileViewResultSchema.parse(JSON.parse(viewed.output));
    assert.equal(viewResult.sha256, expectedSha256);
    assert.ok(viewResult.mtimeMs > 0);

    const scrolled = await executor.execute(viewerCall("file_scroll", {
      path: "sample.txt",
      direction: "down",
      lines: 2,
    }));
    assert.equal(scrolled.ok, true);
    assert.ok(typeof scrolled.output === "string");
    const scrollResult = FileViewResultSchema.parse(JSON.parse(scrolled.output));
    assert.equal(scrollResult.sha256, expectedSha256);
    assert.equal(scrollResult.mtimeMs, viewResult.mtimeMs);

    const read = await executor.execute({
      id: randomUUID(),
      name: "read_file",
      args: { path: "sample.txt", startLine: 1, endLine: 2 },
    });
    assert.equal(read.ok, true);
    const readMetadata = requireLegacyReadMetadata(read.output);
    assert.equal(readMetadata.sha256, expectedSha256);
    assert.ok(readMetadata.mtimeMs > 0);

    const cachedRead = await executor.execute({
      id: randomUUID(),
      name: "read_file",
      args: { path: "sample.txt", startLine: 1, endLine: 2 },
    });
    assert.equal(cachedRead.ok, true);
    assert.deepEqual(requireLegacyReadMetadata(cachedRead.output), readMetadata);

    const legacyView = await executor.execute({
      id: randomUUID(),
      name: "view_file",
      args: { path: "sample.txt", startLine: 2, endLine: 3 },
    });
    assert.equal(legacyView.ok, true);
    const legacyViewMetadata = requireLegacyReadMetadata(legacyView.output);
    assert.equal(legacyViewMetadata.sha256, expectedSha256);
    assert.equal(legacyViewMetadata.mtimeMs, readMetadata.mtimeMs);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});