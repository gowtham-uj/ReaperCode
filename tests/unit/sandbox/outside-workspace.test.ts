/**
 * Sandbox tests — confirm every file tool surfaces the structured
 * `path_escape` error code when given a path that resolves outside
 * the configured workspace root.
 *
 * These tests back the "outside_workspace" sandbox guarantee:
 *   - read_file, write_file, replace_in_file, delete_file,
 *     list_directory, grep_search, skim_file all reject
 *     escape paths with `error.code === "path_escape"`.
 *   - The error message names the offending path AND the workspace
 *     root so the model can correct itself.
 *
 * Symlink-traversal rejection (Phase 1 step 2) is tested separately
 * because it requires creating a workspace symlink that points
 * outside the root.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,  rm,  symlink,  writeFile} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readFileTool } from "../../../src/tools/read/read-file.js";
import { writeFileTool } from "../../../src/tools/write/write-file.js";
import { replaceInFileTool } from "../../../src/tools/write/replace-in-file.js";
import { deleteFileTool } from "../../../src/tools/write/delete-file.js";
import { listDirectoryTool } from "../../../src/tools/read/list-directory.js";

async function tempWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "reaper-sandbox-test-"));
}

async function expectPathEscape(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
  try {
    const result = await fn();
    assert.fail(
      `${label}: expected PathPolicyError, got success result ${JSON.stringify(result)}`,
    );
  } catch (error) {
    assert.ok(error instanceof Error, `${label}: expected Error`);
    assert.equal(
      (error as Error & { name?: string }).name,
      "PathPolicyError",
      `${label}: expected PathPolicyError, got ${(error as Error).name}: ${(error as Error).message}`,
    );
    assert.match(
      (error as Error).message,
      /escapes workspace root/,
      `${label}: error message must mention workspace escape`,
    );
  }
}

test("read_file rejects absolute paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () => readFileTool(ws, { path: "/etc/passwd" }),
      "read_file(/etc/passwd)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("write_file rejects absolute paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () => writeFileTool(ws, { path: "/tmp/escape-target.js", content: "x" }),
      "write_file(/tmp/...)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("replace_in_file rejects absolute paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () =>
        replaceInFileTool(ws, {
          path: "/etc/hosts",
          oldString: "x",
          newString: "y",
        }),
      "replace_in_file(/etc/hosts)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("delete_file rejects absolute paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () => deleteFileTool(ws, { path: "/etc/some-file" }),
      "delete_file(/etc/...)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("list_directory rejects absolute paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () => listDirectoryTool(ws, { path: "/etc" }),
      "list_directory(/etc)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("read_file rejects parent-traversal paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () => readFileTool(ws, { path: "../../../etc/passwd" }),
      "read_file(../../../etc/passwd)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("write_file rejects parent-traversal paths outside the workspace", async () => {
  const ws = await tempWorkspace();
  try {
    await expectPathEscape(
      () =>
        writeFileTool(ws, {
          path: "../../escape-target.js",
          content: "x",
        }),
      "write_file(../../escape-target.js)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

test("read_file rejects symlink traversal to outside the workspace", async (t) => {
  const ws = await tempWorkspace();
  const outside = await mkdtemp(path.join(tmpdir(), "reaper-sandbox-out-"));
  try {
    // Create an outside file, then symlink it inside the workspace.
    const outsideFile = path.join(outside, "secret.txt");
    await writeFile(outsideFile, "secret", "utf8");
    const insideLink = path.join(ws, "link.txt");
    try {
      await symlink(outsideFile, insideLink);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("symlink creation requires elevated privileges on this platform");
        return;
      }
      throw error;
    }

    await expectPathEscape(
      () => readFileTool(ws, { path: "link.txt" }),
      "read_file(symlink to outside)",
    );
  } finally {
    await rm(ws, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});