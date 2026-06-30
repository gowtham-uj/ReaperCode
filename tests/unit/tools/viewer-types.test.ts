/**
 * Unit tests for the viewer's Zod schemas and helper utilities.
 *
 * Schemas are pure and 100% testable. Validation failures must reject with
 * a clear shape; valid input must parse to a typed shape that downstream
 * code can rely on.
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  FileEditArgsSchema,
  FileFindArgsSchema,
  FileScrollArgsSchema,
  FileViewArgsSchema,
  LinterManifestSchema,
  VIEWER_ERROR_CODES,
} from "../../../src/tools/viewer/types.js";

test("FileViewArgsSchema requires path", () => {
  const r = FileViewArgsSchema.safeParse({});
  assert.equal(r.success, false);
});

test("FileViewArgsSchema parses valid args", () => {
  const r = FileViewArgsSchema.safeParse({
    path: "/tmp/a.ts",
    start_line: 1,
    window: 50,
  });
  assert.equal(r.success, true);
});

test("FileViewArgsSchema rejects extra fields (strict)", () => {
  const r = FileViewArgsSchema.safeParse({
    path: "/tmp/a.ts",
    unexpected: true,
  });
  assert.equal(r.success, false);
});

test("FileViewArgsSchema rejects window above the cap of 500", () => {
  const r = FileViewArgsSchema.safeParse({
    path: "/tmp/a.ts",
    window: 501,
  });
  assert.equal(r.success, false);
});

test("FileScrollArgsSchema enforces direction enum", () => {
  const ok = FileScrollArgsSchema.safeParse({ path: "/tmp/a.ts", direction: "up" });
  assert.equal(ok.success, true);
  const bad = FileScrollArgsSchema.safeParse({
    path: "/tmp/a.ts",
    direction: "sideways",
  });
  assert.equal(bad.success, false);
});

test("FileFindArgsSchema requires non-empty pattern", () => {
  const r = FileFindArgsSchema.safeParse({ path: "/tmp/a.ts", pattern: "" });
  assert.equal(r.success, false);
});

test("FileEditArgsSchema rejects start_line > end_line", () => {
  const r = FileEditArgsSchema.safeParse({
    path: "/tmp/a.ts",
    start_line: 50,
    end_line: 10,
    new_content: "x",
  });
  assert.equal(r.success, false);
});

test("FileEditArgsSchema accepts contiguous line range and optional reason metadata", () => {
  const r = FileEditArgsSchema.safeParse({
    path: "/tmp/a.ts",
    start_line: 5,
    end_line: 5,
    new_content: "x",
    reason: "repair failing install",
  });
  assert.equal(r.success, true);
});

test("LinterManifestSchema validates the version-1 shape", () => {
  const ok = LinterManifestSchema.safeParse({
    version: 1,
    defaultTimeoutMs: 5000,
    installTimeoutMs: 30000,
    entries: [
      {
        kind: "pinned_package",
        extensions: [".json"],
        languages: ["json"],
        package: "jsonc-parser",
        version: "2.2.1",
        import: "jsonc-parser",
        symbol: "lint",
      },
    ],
  });
  assert.equal(ok.success, true);
});

test("LinterManifestSchema rejects unknown kind", () => {
  const bad = LinterManifestSchema.safeParse({
    version: 1,
    entries: [
      {
        kind: "totally_made_up",
        extensions: [".x"],
        languages: ["x"],
      },
    ],
  });
  assert.equal(bad.success, false);
});

test("VIEWER_ERROR_CODES includes the codes the executor will surface", () => {
  assert.ok(VIEWER_ERROR_CODES.includes("not_found"));
  assert.ok(VIEWER_ERROR_CODES.includes("lint_failed"));
  assert.ok(VIEWER_ERROR_CODES.includes("lint_unavailable"));
});
