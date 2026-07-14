import { z } from "zod";

/**
 * Zod schemas for the viewer tools.
 *
 * Pure data definitions only. No imports from `node:fs`, executor, or
 * runtime layers. These are wired into `toolRegistry` in Phase 2 and
 * into the actual tool functions in Phase 3. Phase 1 is types-only.
 */

// ============================================================================
// Argument schemas (consumed by the runtime in Phase 2)
// ============================================================================

const NonEmptyPath = z.string().min(1);

export const FileViewArgsSchema = z
  .object({
    path: NonEmptyPath,
    start_line: z.number().int().positive().optional(),
    window: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const FileScrollArgsSchema = z
  .object({
    path: NonEmptyPath,
    direction: z.enum(["up", "down", "top", "bottom"]),
    lines: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const FileFindArgsSchema = z
  .object({
    path: NonEmptyPath,
    pattern: z.string().min(1),
    start_line: z.number().int().positive().optional(),
  })
  .strict();

export const FileEditArgsSchema = z
  .object({
    path: NonEmptyPath,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    new_content: z.string(),
    /** Optional model-supplied rationale; ignored by execution. */
    reason: z.string().optional(),
  })
  .strict()
  .refine((v) => v.start_line <= v.end_line, {
    message: "start_line must be <= end_line",
  });

export type FileViewArgs = z.infer<typeof FileViewArgsSchema>;
export type FileScrollArgs = z.infer<typeof FileScrollArgsSchema>;
export type FileFindArgs = z.infer<typeof FileFindArgsSchema>;
export type FileEditArgs = z.infer<typeof FileEditArgsSchema>;

// ============================================================================
// Result schemas (consumed by the tool functions in Phase 3)
// ============================================================================

export const FileViewResultSchema = z
  .object({
    kind: z.literal("file_view"),
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    totalLines: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mtimeMs: z.number().nonnegative(),
    truncated: z.boolean(),
    window: z.array(z.string()),
  })
  .strict();

export const FileFindResultSchema = z
  .object({
    kind: z.literal("file_find"),
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    matchedLine: z.number().int().positive(),
    window: z.array(z.string()),
    matchCount: z.number().int().nonnegative(),
  })
  .strict();

export const LintVerdictSchema = z
  .object({
    language: z.string(),
    source: z.enum([
      "manifest_pinned",
      "manifest_runtime",
      "builtin",
      "fallback_permissive",
    ]),
    ok: z.boolean(),
    message: z.string().optional(),
    line: z.number().int().positive().optional(),
    installLatencyMs: z.number().nonnegative().optional(),
    attempts: z.array(z.string()).optional(),
  })
  .strict();

export const FileEditResultSchema = z
  .object({
    kind: z.literal("file_edit"),
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    totalLines: z.number().int().nonnegative(),
    window: z.array(z.string()),
    lintVerdict: LintVerdictSchema,
  })
  .strict();

export type FileViewResult = z.infer<typeof FileViewResultSchema>;
export type FileFindResult = z.infer<typeof FileFindResultSchema>;
export type LintVerdict = z.infer<typeof LintVerdictSchema>;
export type FileEditResult = z.infer<typeof FileEditResultSchema>;

// ============================================================================
// Linter manifest schema. Authored in `src/tools/viewer/linters/manifest.json`.
// Adding a language means adding a `.ts` file under `linters/<lang>.ts` and an
// entry here. The Phase-1 dispatcher reads this file lazily.
// ============================================================================

const PinnedPackageEntrySchema = z
  .object({
    kind: z.literal("pinned_package"),
    extensions: z.array(z.string().min(1)).min(1),
    languages: z.array(z.string().min(1)).min(1),
    package: z.string().min(1),
    version: z.string().min(1),
    import: z.string().min(1),
    symbol: z.string().min(1),
  })
  .strict();

const RuntimeCommandEntrySchema = z
  .object({
    kind: z.literal("runtime_command"),
    extensions: z.array(z.string().min(1)).min(1),
    languages: z.array(z.string().min(1)).min(1),
    command: z.array(z.string().min(1)).min(1),
    fileArgIndex: z.number().int().nonnegative(),
    parseStderr: z.boolean().optional(),
  })
  .strict();

export const LinterManifestEntrySchema = z.discriminatedUnion("kind", [
  PinnedPackageEntrySchema,
  RuntimeCommandEntrySchema,
]);
export type LinterManifestEntry = z.infer<typeof LinterManifestEntrySchema>;

export const LinterManifestSchema = z
  .object({
    version: z.literal(1),
    defaultTimeoutMs: z.number().int().positive().max(30_000).default(5_000),
    installTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
    entries: z.array(LinterManifestEntrySchema).default([]),
  })
  .strict();
export type LinterManifest = z.infer<typeof LinterManifestSchema>;

// ============================================================================
// `toolResult.ts`-compatible error codes the viewer uses. Re-uses values the
// rest of Reaper already recognizes when possible; introduces three new codes
// when no existing code fits.
// ============================================================================
export const VIEWER_ERROR_CODES = [
  "not_found",
  "invalid_argument",
  "permission_denied",
  "lint_failed",
  "lint_unavailable",
  "io_error",
] as const;
export type ViewerErrorCode = (typeof VIEWER_ERROR_CODES)[number];
