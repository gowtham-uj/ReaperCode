import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Theme resource helpers.
 *
 * A "theme" is a JSON or CSS file under `<base>/themes/` (or referenced from
 * a package manifest). Themes follow the same precedence rules as other
 * resource kinds, and the resource loader picks them up via the
 * `themes` slot on `ResolvedResources`.
 */

export interface ResolvedTheme {
  /** Stable identifier — basename without extension for direct files, JSON `name` for theme.json. */
  id: string;
  /** Absolute path to the theme file on disk. */
  path: string;
  /** Theme source format. */
  format: "json" | "css";
  /** Whether the theme file was successfully parsed; false yields a placeholder. */
  parsed: boolean;
}

const THEME_FILE_EXTENSIONS = [".json", ".css"] as const;

export function isThemeFileName(name: string): boolean {
  return THEME_FILE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

export async function listThemeFiles(themeDir: string): Promise<string[]> {
  if (!existsSync(themeDir)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(themeDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (isThemeFileName(entry.name)) files.push(path.join(themeDir, entry.name));
  }
  files.sort();
  return files;
}

export async function resolveTheme(filePath: string): Promise<ResolvedTheme> {
  const ext = path.extname(filePath).toLowerCase();
  const format: ResolvedTheme["format"] = ext === ".json" ? "json" : "css";
  const baseId = path.basename(filePath, ext);
  if (format === "json") {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      const name = typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : baseId;
      return { id: name, path: filePath, format, parsed: true };
    } catch {
      return { id: baseId, path: filePath, format, parsed: false };
    }
  }
  try {
    await stat(filePath);
    return { id: baseId, path: filePath, format, parsed: true };
  } catch {
    return { id: baseId, path: filePath, format, parsed: false };
  }
}