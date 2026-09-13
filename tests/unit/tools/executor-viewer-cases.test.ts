import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolExecutor } from "../../../src/tools/executor.js";
import { normalizeToolCall } from "../../../src/tools/normalize.js";
import type { ToolCall } from "../../../src/tools/types.js";
import { FileViewResultSchema } from "../../../src/tools/viewer/types.js";
import { outputOf } from "../../helpers/tool-output.js";

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

function viewerCall(name: "file_view", args: Record<string, unknown>): ToolCall {
  const runtimeViewerCall = { id: randomUUID(), name, args };
  // Viewer calls are deliberately intercepted before the legacy ToolCall union switch.
  return runtimeViewerCall as unknown as ToolCall;
}

/**
 * Viewer tools answer with a JSON *string* carrying the strict
 * `FileViewResultSchema` shape. The retired `view_file` name now lands on the
 * same dispatcher, so it answers the same way — that is the point of the alias
 * rather than a second code path with its own shape.
 */
/*
 * The viewer's result reaches a caller as a value, not as JSON text.
 *
 * This read `if (typeof output !== "string") throw` — asserting the string
 * contract rather than merely tolerating it — which made the file fail the
 * moment that contract was corrected. The shape it should be asserting is the
 * freshness metadata, so that is what it asserts now; `outputOf` accepts either
 * encoding so the helper is not the thing that breaks next time.
 */
function requireViewMetadata(output: unknown): { sha256: string; mtimeMs: number } {
  const parsed = FileViewResultSchema.parse(outputOf({ output }));
  return { sha256: parsed.sha256, mtimeMs: parsed.mtimeMs };
}

test("viewer and legacy view results expose one strict freshness shape", async () => {
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
    const viewResult = FileViewResultSchema.parse(outputOf(viewed));
    assert.equal(viewResult.sha256, expectedSha256);
    assert.ok(viewResult.mtimeMs > 0);

    const secondWindow = await executor.execute(viewerCall("file_view", {
      path: "sample.txt",
      start_line: 2,
      window: 2,
    }));
    assert.equal(secondWindow.ok, true);
    const secondResult = FileViewResultSchema.parse(outputOf(secondWindow));
    assert.equal(secondResult.sha256, expectedSha256);
    assert.equal(secondResult.mtimeMs, viewResult.mtimeMs);

    // `view_file` is a retired name. A model that still emits it — with the
    // old `startLine`/`endLine` pair — must land on `file_view` with a real
    // window, and must expose the same freshness shape as a native call.
    // Without the alias it would be rejected as an unknown tool; without the
    // end-line translation it would arrive with a `path` and nothing else.
    const retired = normalizeToolCall({
      id: randomUUID(),
      name: "view_file",
      args: { path: "sample.txt", startLine: 2, endLine: 3 },
    }) as { name: string; args: Record<string, unknown> };
    assert.equal(retired.name, "file_view");
    assert.deepEqual(retired.args, { path: "sample.txt", start_line: 2, window: 2 });

    const retiredView = await executor.execute(retired as unknown as ToolCall);
    assert.equal(retiredView.ok, true);
    const retiredMetadata = requireViewMetadata(retiredView.output);
    assert.equal(retiredMetadata.sha256, expectedSha256);
    assert.ok(retiredMetadata.mtimeMs > 0);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});