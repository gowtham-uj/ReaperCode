/**
 * Turning whatever a browser script returned into text safe to put in front of
 * the model.
 *
 * The governing rule is that **nothing is dropped silently**. A truncated
 * array, a cut string, a cycle, an object too deep to walk — each says so in the
 * output. Silent loss reads as "that was everything", which is the failure mode
 * that makes a tool untrustworthy rather than merely limited.
 *
 * The case that motivated most of this is `playwrightName` below: returning a
 * `Page` instead of something from it is the most common mistake a model makes
 * here, and walking a Page as a plain object dumps its internal connection
 * plumbing into the context.
 */

/** How deep the walk goes before it stops and says so. */
export const MAX_DEPTH = 6;
/** Most entries kept from one array or object. */
export const MAX_ENTRIES = 100;
/** Longest string kept whole; longer ones are cut on a word boundary. */
export const MAX_STRING = 8_000;
/** Ceiling on the whole serialized payload. */
export const MAX_TOTAL_CHARS = 50_000;

export interface SerializeOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxString?: number;
  maxTotalChars?: number;
}

export interface SerializeResult {
  value: unknown;
  /** True when any cap was hit, so the caller can say so once. */
  truncated: boolean;
  /** Serialized size before any truncation, in characters. */
  bytes: number;
}

/**
 * Whether a value is a Playwright object, detected structurally.
 *
 * Not by class name. Playwright's classes are all prefixed and private
 * (`_Page`, `_Locator`, `_BrowserContext`), and they are not exported, so a list
 * built from the public API names — `Page`, `Locator` — matches nothing. What
 * every one of them *does* share is the shape a channel-based client object has:
 * a `_channel` for talking to the browser and a `_connection` that owns the
 * channel. `_initializer.type` carries the protocol name when it is present,
 * which is what lets this report "Page" rather than "an object".
 *
 * The check is deliberately loose about the type string and strict about the
 * two fields: a script's own object that happens to be called `page` should not
 * be mistaken for one, and a real Page from a Playwright version that renames
 * its type field still should be.
 */
export function playwrightName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { _channel?: unknown; _connection?: unknown; _initializer?: { type?: unknown } };
  if (!candidate._channel || !candidate._connection) return undefined;
  const protocolType = candidate._initializer?.type;
  if (typeof protocolType === "string" && protocolType.length > 0) {
    // The protocol type is lowercase (`page`, `frame`, `browserContext`); the
    // public name is the same word capitalised.
    return protocolType.charAt(0).toUpperCase() + protocolType.slice(1);
  }
  return "PlaywrightObject";
}

/**
 * Walk a value and produce something JSON-safe and bounded.
 *
 * Exported as a plain function rather than a class because it is pure: no
 * state survives a call, so two calls with the same input agree, which is what
 * makes it testable without a browser.
 */
export function serializeBrowserResult(value: unknown, options: SerializeOptions = {}): SerializeResult {
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxString = options.maxString ?? MAX_STRING;

  const seen = new WeakSet<object>();

  function walk(node: unknown, depth: number): unknown {
    if (node === null || node === undefined) return node;
    const type = typeof node;

    if (type === "string") {
      const text = node as string;
      return text.length <= maxString
        ? text
        : `${text.slice(0, maxString)}\n[... ${text.length - maxString} more characters]`;
    }
    if (type === "number") {
      /*
       * `NaN` and `Infinity` become strings. As numbers they are not valid
       * JSON, so `JSON.stringify` turns them into `null`, which the model reads
       * as "no value" rather than "not a number" — and a page that returned NaN
       * is a different fact from one that returned nothing.
       */
      const n = node as number;
      return Number.isFinite(n) ? n : String(n);
    }
    if (type === "boolean") return node;
    if (type === "bigint") return `${(node as bigint).toString()}n`;
    if (type === "function") {
      const fn = node as { name?: string };
      return `[Function${fn.name ? `: ${fn.name}` : ""}]`;
    }
    if (type === "symbol") return String(node);

    /*
     * Playwright first, before anything else looks at the object. A Page has
     * the shape of a plain object with a `_connection` that owns a tree of
     * channels, so walking it is both enormous and useless — and it is the
     * mistake this whole module is built around.
     */
    const pw = playwrightName(node);
    if (pw) {
      const asPage = node as { url?: unknown };
      const hint =
        pw === "Page" && typeof asPage.url === "function"
          ? " — did you mean `await page.title()` or `await page.url()`, or a locator's text?"
          : "";
      return `[Playwright ${pw}]${hint}`;
    }

    if (node instanceof Error) {
      return { name: node.name, message: node.message };
    }
    if (node instanceof Date) return node.toISOString();
    if (depth >= maxDepth) return "[nested too deeply — this is as far as the serializer walks]";
    if (seen.has(node as object)) return "[Circular]";
    seen.add(node as object);

    if (node instanceof Map) {
      const entries = [...node.entries()].slice(0, maxEntries).map(([k, v]) => [walk(k, depth + 1), walk(v, depth + 1)]);
      return node.size > maxEntries ? [...entries, `[+${node.size - maxEntries} more entries]`] : entries;
    }
    if (node instanceof Set) {
      const items = [...node.values()].slice(0, maxEntries).map((item) => walk(item, depth + 1));
      return node.size > maxEntries ? [...items, `[+${node.size - maxEntries} more items]`] : items;
    }
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer) {
      const bytes = (node as ArrayBufferView | ArrayBuffer).byteLength;
      return `[binary ${bytes} byte${bytes === 1 ? "" : "s"}]`;
    }
    if (Array.isArray(node)) {
      const kept = node.slice(0, maxEntries).map((item) => walk(item, depth + 1));
      return node.length > maxEntries ? [...kept, `[+${node.length - maxEntries} more items]`] : kept;
    }

    const source = node as Record<string, unknown>;
    const keys = Object.keys(source);
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, maxEntries)) {
      try {
        out[key] = walk(source[key], depth + 1);
      } catch (error) {
        // A getter that throws must not lose the whole result; the fact that it
        // threw is itself information.
        out[key] = `[threw on access: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    if (keys.length > maxEntries) out["..."] = `[+${keys.length - maxEntries} more keys]`;
    return out;
  }

  let walked: unknown;
  try {
    walked = walk(value, 0);
  } catch (error) {
    walked = `[could not serialize the returned value: ${error instanceof Error ? error.message : String(error)}]`;
  }

  let text: string;
  try {
    text = JSON.stringify(walked) ?? String(walked);
  } catch {
    text = String(walked);
  }
  const bytes = text.length;
  const maxTotalChars = options.maxTotalChars ?? MAX_TOTAL_CHARS;

  if (bytes <= maxTotalChars) return { value: walked, truncated: false, bytes };

  /*
   * Cut on a line boundary where there is one, so the preview ends at something
   * readable rather than mid-token. The count of what was dropped is stated
   * because a preview that just ends looks like the whole value.
   */
  const cut = text.slice(0, maxTotalChars);
  const lastNewline = cut.lastIndexOf("\n");
  const preview = lastNewline > maxTotalChars * 0.6 ? cut.slice(0, lastNewline) : cut;
  return {
    value: `${preview}\n[result truncated: ${bytes - preview.length} more characters not shown]`,
    truncated: true,
    bytes,
  };
}
