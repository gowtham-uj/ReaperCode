/**
 * FileViewerRegistry — pure per-path viewport state.
 *
 * Modeled as a class with a `Map<absolutePath, FileViewState>` so it composes
 * with the executor's instance-field state pattern (`src/tools/executor.ts`
 * `this.readOutputCache`/`this.fileWriteCounts`). It carries NO filesystem
 * access. The tool bodies in Phase 3 read content and pass it here; this
 * registry tracks per-path anchor / start / total / mtime / sha256.
 *
 * Bounds: `startLine >= 1` and `endLine <= totalLines + 1`. Returns the
 * clamped window in `[startLine, endLine)`.
 */

export interface FileViewState {
  /** Absolute, normalized path. */
  path: string;
  /** Anchor line for `file_scroll up`/`down`. */
  anchorLine: number;
  /** Last shown start line. */
  startLine: number;
  /** Last shown end line (exclusive). */
  endLine: number;
  /** Last seen file total lines at read time. */
  totalLines: number;
  /** Last seen file SHA-256 (`""` if unavailable). */
  sha256: string;
  /** Last seen file `mtimeMs` (0 if unavailable). */
  mtimeMs: number;
}

export interface ViewWindow {
  startLine: number;
  endLine: number;
  /** Anchor line within `[startLine, endLine]`. */
  anchorLine: number;
  totalLines: number;
  truncated: boolean;
}

const DEFAULT_WINDOW = 50;

/** Numbered line shape used by all four viewer tools. */
export function numberLines(lines: string[], startLine: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    result.push(`${startLine + i}: ${lines[i] ?? ""}`);
  }
  return result;
}

/** Compute a window against a content length. Clamps into bounds. */
export function clampWindow(
  startLine: number,
  window: number,
  totalLines: number,
): { start: number; end: number; truncated: boolean } {
  const safeWindow = Math.max(1, Math.min(window, 500));
  // startLine is 1-indexed; end is exclusive.
  const start = Math.max(1, Math.min(startLine, Math.max(1, totalLines)));
  const end = Math.min(totalLines + 1, start + safeWindow);
  return {
    start,
    end,
    truncated: end < totalLines + 1 && end - start >= safeWindow,
  };
}

export class FileViewerRegistry {
  private readonly states = new Map<string, FileViewState>();

  get(path: string): FileViewState | undefined {
    return this.states.get(path);
  }

  set(state: FileViewState): void {
    this.states.set(state.path, state);
  }

  invalidate(path: string): void {
    this.states.delete(path);
  }

  clear(): void {
    this.states.clear();
  }

  entries(): IterableIterator<FileViewState> {
    return this.states.values();
  }

  /** Read or initialize a view for `path`. Pure — does not touch disk. */
  readOrInit(
    path: string,
    totalLines: number,
    sha256: string,
    mtimeMs: number,
    defaults: { startLine?: number; window?: number } = {},
  ): { state: FileViewState; window: ViewWindow } {
    const existing = this.states.get(path);
    if (
      existing &&
      existing.totalLines === totalLines &&
      existing.sha256 === sha256 &&
      existing.mtimeMs === mtimeMs
    ) {
      return { state: existing, window: this.windowOf(existing) };
    }

    const startLine = existing?.startLine ?? defaults.startLine ?? 1;
    const viewEndLine = existing?.endLine;
    const next: FileViewState = {
      path,
      anchorLine: existing?.anchorLine ?? startLine,
      startLine,
      endLine: viewEndLine ?? startLine + (defaults.window ?? DEFAULT_WINDOW),
      totalLines,
      sha256,
      mtimeMs,
    };
    this.states.set(path, next);
    return {
      state: next,
      window: this.windowOf(next),
    };
  }

  /** Apply a scroll delta to an existing view. */
  scroll(
    path: string,
    direction: "up" | "down" | "top" | "bottom",
    lines = DEFAULT_WINDOW,
    totalLines = this.states.get(path)?.totalLines ?? 0,
  ): ViewWindow | undefined {
    const cur = this.states.get(path);
    if (!cur) return undefined;
    const anchor = cur.anchorLine;
    let start: number;
    switch (direction) {
      case "top":
        start = 1;
        break;
      case "bottom": {
        const endExclusive = Math.min(totalLines + 1, anchor + lines);
        start = Math.max(1, endExclusive - lines);
        break;
      }
      case "up":
        start = Math.max(1, cur.startLine - lines);
        break;
      case "down":
        start = Math.min(Math.max(1, totalLines - lines + 1), cur.endLine);
        break;
      default:
        return undefined;
    }
    const end = Math.min(totalLines + 1, start + lines);
    const next: FileViewState = {
      ...cur,
      startLine: start,
      endLine: end,
      anchorLine: Math.max(start, Math.min(end - 1, anchor)),
    };
    this.states.set(path, next);
    return this.windowOf(next);
  }

  /** Find the first match of `pattern` within `lines`, centered the viewport. */
  find(
    path: string,
    pattern: string,
    lines: string[],
  ): { view: FileViewState; matchedLine: number } | undefined {
    if (!lines.length) return undefined;
    const cur = this.states.get(path);
    const totalLines = lines.length;

    const startFrom = cur?.startLine ?? 1;
    const haystack = lines.join("\n");
    const idx = haystack.indexOf(pattern, Math.max(0, startFrom - 1));
    const matchLine = idx < 0
      ? lines.findIndex((line) => line.includes(pattern)) + 1
      : (() => {
          let consumed = 0;
          for (let i = 0; i < lines.length; i += 1) {
            const lineLen = (lines[i] ?? "").length + 1;
            if (consumed + lineLen > idx) return i + 1;
            consumed += lineLen;
          }
          return lines.length;
        })();

    if (matchLine <= 0) return undefined;

    const halfWindow = Math.floor(DEFAULT_WINDOW / 2);
    const start = Math.max(1, matchLine - halfWindow);
    const end = Math.min(totalLines + 1, start + DEFAULT_WINDOW);
    const finalStart = end - start < DEFAULT_WINDOW ? Math.max(1, end - DEFAULT_WINDOW) : start;

    const next: FileViewState = {
      path,
      anchorLine: matchLine,
      startLine: finalStart,
      endLine: end,
      totalLines,
      sha256: cur?.sha256 ?? "",
      mtimeMs: cur?.mtimeMs ?? 0,
    };
    this.states.set(path, next);
    return { view: next, matchedLine: matchLine };
  }

  /** Update the registration after a successful `file_edit`. */
  noteEdit(
    path: string,
    totalLines: number,
    sha256: string,
    mtimeMs: number,
  ): FileViewState | undefined {
    const cur = this.states.get(path);
    const next: FileViewState = {
      path,
      anchorLine: cur?.anchorLine ?? 1,
      startLine: cur?.startLine ?? 1,
      endLine: cur?.endLine ?? Math.min(totalLines + 1, 1 + DEFAULT_WINDOW),
      totalLines,
      sha256,
      mtimeMs,
    };
    this.states.set(path, next);
    return next;
  }

  private windowOf(state: FileViewState): ViewWindow {
    const start = Math.max(1, Math.min(state.startLine, Math.max(1, state.totalLines)));
    const end = Math.min(state.totalLines + 1, Math.max(start + 1, state.endLine));
    return {
      startLine: start,
      endLine: end,
      anchorLine: Math.max(start, Math.min(end - 1, state.anchorLine)),
      totalLines: state.totalLines,
      truncated: end - start === DEFAULT_WINDOW && end < state.totalLines + 1,
    };
  }
}
