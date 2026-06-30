/**
 * Per-session input history ring buffer. Backs the ↑/↓ walk in the
 * input prompt and the Ctrl-R reverse-i-search popover.
 *
 * The buffer is in-memory only — when the session is resumed from
 * disk the history is hydrated by the session-store.
 */

const DEFAULT_CAPACITY = 200;

export class HistoryBuffer {
  private readonly items: string[] = [];
  private cursor = -1;
  /** The prompt the user had typed before opening history; restored
   *  when they walk off the end of the buffer with ↓. */
  private draft = "";

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /** Append a fresh prompt. Resets the cursor to "off the end". */
  push(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    // Avoid duplicates of the most-recent entry (a common UX nit).
    if (this.items[this.items.length - 1] === trimmed) {
      this.cursor = -1;
      this.draft = "";
      return;
    }
    this.items.push(trimmed);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
    this.cursor = -1;
    this.draft = "";
  }

  /** Snapshot for persistence. */
  snapshot(): string[] {
    return [...this.items];
  }

  hydrate(items: string[]): void {
    this.items.length = 0;
    for (const it of items.slice(-this.capacity)) this.items.push(it);
    this.cursor = -1;
    this.draft = "";
  }

  /** Return the previous entry, or null if at the start. */
  up(currentDraft: string): string | null {
    if (this.items.length === 0) return null;
    if (this.cursor === -1) {
      // First press: remember the live draft.
      this.draft = currentDraft;
      this.cursor = this.items.length - 1;
    } else if (this.cursor > 0) {
      this.cursor -= 1;
    } else {
      return null; // already at oldest
    }
    return this.items[this.cursor] ?? null;
  }

  /** Return the next entry, or restore the live draft if walking off the end. */
  down(): string | null {
    if (this.cursor === -1) return null;
    if (this.cursor < this.items.length - 1) {
      this.cursor += 1;
      return this.items[this.cursor] ?? null;
    }
    // Walked off the end — restore the draft.
    this.cursor = -1;
    const draft = this.draft;
    this.draft = "";
    return draft;
  }

  /** Reset the cursor without changing the buffer. Used after submitting. */
  resetCursor(): void {
    this.cursor = -1;
    this.draft = "";
  }

  /** Return the last N items (newest first). */
  recent(n: number): string[] {
    return this.items.slice(-n).reverse();
  }

  /** Reverse-i-search: return matches where the entry contains `needle`. */
  search(needle: string): string[] {
    const out: string[] = [];
    const lower = needle.toLowerCase();
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i] ?? "";
      if (it.toLowerCase().includes(lower)) out.push(it);
    }
    return out;
  }

  size(): number {
    return this.items.length;
  }
}