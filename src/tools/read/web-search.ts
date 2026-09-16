
import { assertPublicUrl } from "../../util/ssrf-guard.js";

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchArgs {
  query: string;
  engine?: "duckduckgo" | "mimo" | "serper" | "auto";
  maxResults?: number;
  scrapePages?: number;
}

export interface ScrapedResult extends SearchResult {
  scraped: boolean;
  summary?: string;
  error?: string;
}

export interface ResearchSynthesis {
  summary: string;
  solutionCandidates: string[];
  recommendedOrder: string[];
}

export interface WebSearchResult {
  query: string;
  engine: "mimo" | "serper" | "duckduckgo";
  searchedAt: string;
  requestedPages: number;
  scrapedPages: number;
  results: ScrapedResult[];
  synthesis: ResearchSynthesis;
  /**
   * Engines that ran and returned nothing, when the search came back empty.
   *
   * An empty result list is the one answer a model cannot act on: it cannot
   * tell "the web has nothing" from "every backend is down" from "a key is
   * missing". The audit hit exactly that — `results: []` with no explanation,
   * for a query that plainly has an answer. Naming which engines were consulted
   * and which were skipped for want of a key turns a dead end into a next step.
   */
  notes?: string[];
}

export async function webSearchTool(
  args: WebSearchArgs,
  options: Record<string, any> = {},
): Promise<WebSearchResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as any);
  const query = args.query;
  const maxResults = args.maxResults ?? 10;

  /*
   * The requested engine is honoured rather than ignored.
   *
   * The argument was declared in the schema and then discarded: every call ran
   * all three backends in parallel and reported a hardcoded `engine: "mimo"`,
   * so a caller that named `duckduckgo` got whatever the union produced and a
   * label that named an engine not in the schema's own enum. `auto` (the
   * default) keeps the parallel union, which is the useful behaviour; an
   * explicit engine runs only that one.
   */
  const requested = args.engine ?? "auto";
  const notes: string[] = [];

  const engines: Array<{ name: WebSearchResult["engine"]; run: () => Promise<SearchResult[]> }> = [
    { name: "mimo", run: () => searchMiMo(query, maxResults, fetchImpl) },
    { name: "serper", run: () => searchSerper(query, maxResults, fetchImpl) },
    { name: "duckduckgo", run: () => searchDuckDuckGo(query, maxResults, fetchImpl) },
  ];

  const selected = requested === "auto" ? engines : engines.filter((e) => e.name === requested);

  const settled = await Promise.all(
    selected.map(async (engine) => {
      try {
        return { name: engine.name, results: await engine.run() };
      } catch (error) {
        notes.push(`${engine.name}: ${error instanceof Error ? error.message : String(error)}`);
        return { name: engine.name, results: [] as SearchResult[] };
      }
    }),
  );

  // Merge and deduplicate
  const allResults = dedupeByUrl(settled.flatMap((s) => s.results)).slice(0, maxResults);

  if (allResults.length === 0) {
    for (const entry of settled) {
      if (entry.results.length === 0) notes.push(`${entry.name}: returned no results`);
    }
    const mimoKeyed = Boolean(process.env.MIMO_SEARCH_API_KEY);
    const serperKeyed = Boolean(process.env.SERPER_SEARCH_API_KEY);
    if (!mimoKeyed && !serperKeyed && requested === "auto") {
      notes.push("MIMO_SEARCH_API_KEY and SERPER_SEARCH_API_KEY are unset, so only the keyless DuckDuckGo backend could answer");
    }
  }

  // Scrape pages for content (max 300 chars each for context safety)
  const scraped: ScrapedResult[] = await Promise.all(
    allResults.slice(0, Math.min(maxResults, 10)).map(async (result) => {
      try {
        const html = await fetchText(result.url, fetchImpl, 15_000);
        return { ...result, scraped: true, summary: summarizePage(extractReadableText(html), query) };
      } catch (error: any) {
        return { ...result, scraped: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  const synthesis = synthesizeResearch(query, scraped);

  return {
    query,
    // The engine that actually answered, not a fixed label: `auto` reports the
    // first backend that produced results, an explicit request reports itself.
    engine: requested === "auto" ? (settled.find((s) => s.results.length > 0)?.name ?? "duckduckgo") : requested,
    searchedAt: new Date().toISOString(),
    requestedPages: maxResults,
    scrapedPages: scraped.filter((s) => s.scraped).length,
    results: scraped,
    synthesis,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// ===== MiMo AI Search =====
async function searchMiMo(query: string, maxResults: number, fetchImpl: any): Promise<SearchResult[]> {
  const apiKey = process.env.MIMO_SEARCH_API_KEY || "";
  if (!apiKey) return [];
  try {
    const response = await fetchWithTimeout("https://api.xiaomimimo.com/v1/chat/completions", fetchImpl, 20_000, {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "mimo-v2.5-pro",
        messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search", max_keyword: 5, force_search: true, limit: maxResults }],
        max_completion_tokens: 2048,
        temperature: 1.0, top_p: 0.95, stream: false,
        thinking: { type: "disabled" },
      }),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    const message = data.choices?.[0]?.message;
    const results: SearchResult[] = [];
    if (Array.isArray(message?.annotations)) {
      for (const ann of message.annotations) {
        if (ann.type === "url_citation" && ann.url) {
          results.push({ title: ann.title || ann.url, url: ann.url, snippet: ann.summary || "" });
        }
      }
    }
    return dedupeByUrl(results).slice(0, maxResults);
  } catch {
    return [];
  }
}

// ===== Serper.dev Google Search =====
async function searchSerper(query: string, maxResults: number, fetchImpl: any): Promise<SearchResult[]> {
  const apiKey = process.env.SERPER_SEARCH_API_KEY || "";
  if (!apiKey) return [];
  try {
    const response = await fetchWithTimeout("https://google.serper.dev/search", fetchImpl, 10_000, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: maxResults }),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    const results: SearchResult[] = [];
    for (const item of (data.organic || [])) {
      if (item.link && item.title) {
        results.push({ title: item.title, url: item.link, snippet: item.snippet || "" });
      }
    }
    return results.slice(0, maxResults);
  } catch {
    return [];
  }
}

// ===== DuckDuckGo Free Search =====

/** The UA the DDG endpoints answer to; the default fetch UA is rejected. */
const DDG_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * The keyless backend, and the only one that works without a paid key.
 *
 * Two things were wrong with the first version. It POSTed to
 * `html.duckduckgo.com/html/`, which now answers `202` with an anti-bot shell:
 * status 202 is "accepted", so `response.ok` was true and the parser ran over a
 * page with no results in it, returning `[]` for every query. And it parsed
 * `uddg=` URL fragments alone, so even a page that did carry results would have
 * produced bare URLs with the last path segment as the title.
 *
 * The `lite.duckduckgo.com/lite/` endpoint answers a plain GET with real markup,
 * which this parses properly: the `result-link` anchor carries the title and the
 * `uddg` parameter carries the destination. The POST form is tried second
 * because it is the more documented shape and may start working again; the GET
 * is the one that currently answers.
 */
async function searchDuckDuckGo(query: string, maxResults: number, fetchImpl: any): Promise<SearchResult[]> {
  const attempts: Array<{ url: string; init: RequestInit }> = [
    { url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, init: { method: "GET" } },
    {
      url: "https://html.duckduckgo.com/html/",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "q=" + encodeURIComponent(query),
      },
    },
  ];

  for (const attempt of attempts) {
    try {
      const response = await fetchWithTimeout(attempt.url, fetchImpl, 10_000, {
        ...attempt.init,
        headers: { ...(attempt.init.headers as Record<string, string> | undefined), "User-Agent": DDG_USER_AGENT },
      });
      if (!response.ok) continue;
      const parsed = parseDDGResults(await response.text(), maxResults);
      if (parsed.length > 0) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return [];
}

function parseDDGResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  /*
   * Anchors first: the link carries the human title and its href carries the
   * destination either directly or behind the `uddg` redirect parameter. Both
   * endpoints' class names are accepted — the lite page uses `result-link` and
   * the html page uses `result__a` — so one parser covers both attempts above
   * and either page shape yields titles rather than bare URLs.
   */
  /*
   * Attribute order is not fixed across the two pages — the lite page writes
   * `href` before `class`, the html page the other way round — so the pattern
   * captures each attribute independently and requires only that both are
   * present on the tag.
   */
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attrs = match[1] ?? "";
    if (!/\bresult[-_][\w-]*/.test(attrs)) continue;
    const href = /\bhref=['"]([^'"]+)['"]/.exec(attrs)?.[1];
    if (!href) continue;
    const title = stripTags(match[2] ?? "").trim();
    const url = unwrapDuckDuckGoUrl(href);
    if (!url || !url.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    results.push({ title: title || url, url, snippet: "" });
    if (results.length >= maxResults) return results;
  }

  /*
   * Fallback for a page whose anchors did not match. This is the old
   * `uddg=`-only path, kept so a markup change degrades to bare URLs rather
   * than to nothing — the URLs are still usable even without titles.
   */
  if (results.length === 0) {
    for (const match of html.matchAll(/uddg=([^&"']+)/g)) {
      let url: string;
      try {
        url = decodeURIComponent(match[1]!);
      } catch {
        continue;
      }
      if (!url.startsWith("http") || seen.has(url)) continue;
      seen.add(url);
      results.push({ title: url.split("/").pop() || url, url, snippet: "" });
      if (results.length >= maxResults) break;
    }
  }

  return results;
}

/** Resolve a DDG href, which may be a `//duckduckgo.com/l/?uddg=…` redirect. */
function unwrapDuckDuckGoUrl(href: string): string | undefined {
  if (!href) return undefined;
  // Protocol-relative links are common in the response.
  const absolute = href.startsWith("//") ? `https:${href}` : href;
  const uddg = /[?&]uddg=([^&]+)/.exec(absolute);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      return undefined;
    }
  }
  return absolute;
}

/** Strip tags and decode the handful of entities a result title can carry. */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// ===== Deduplication =====
function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = r.url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ===== HTTP Helpers =====
async function fetchText(url: string, fetchImpl: any, timeoutMs: number): Promise<string> {
  // Scraped result URLs come from a third-party index and may point at
  // internal hosts. Enforce the same SSRF guard web-fetch uses.
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
      redirect: "follow",
    });
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithTimeout(url: string, fetchImpl: any, timeoutMs: number, init: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ===== CONTEXT-SAFE HTML Parsing =====
function extractReadableText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ===== CONTEXT-SAFE Summarization (max 300 chars per page) =====
function summarizePage(text: string, query: string): string {
  const terms = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(t => t.length > 2);
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const scored = sentences
    .map((s, i) => ({
      sentence: s,
      index: i,
      score: terms.reduce((sc, t) => sc + (s.toLowerCase().includes(t) ? 1 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return (scored.length > 0 ? scored : sentences.slice(0, 1)).join(" ").slice(0, 300);
}

// ===== CONTEXT-SAFE Synthesis (concise, actionable output) =====
function synthesizeResearch(query: string, results: ScrapedResult[]): ResearchSynthesis {
  const allText = results
    .filter((r) => r.scraped)
    .map((r) => (r.summary || r.snippet || ""))
    .join(" ")
    .toLowerCase();

  const candidates = new Set<string>();

  if (/jest|typescript|test|beforeall|expect/.test(allText))
    candidates.add("Check test config: ts-jest/jest compatibility, @types/jest");
  if (/sqlite|glibc|native|better-sqlite3/.test(allText))
    candidates.add("Use better-sqlite3 or sql.js (pure JS) for DB");
  if (/express|ws|websocket/.test(allText))
    candidates.add("WebSocket: use ws library with express http.Server");
  if (/vite|react-scripts|webpack/.test(allText))
    candidates.add("Build: downgrade Vite to v5 or use tsx");
  if (/docker|container/.test(allText))
    candidates.add("Docker not available, use direct commands");
  if (/bcrypt|auth|cors/.test(allText))
    candidates.add("Auth: use bcryptjs, cors middleware");
  if (candidates.size === 0)
    candidates.add("Apply smallest fix matching the error, then retry");

  const arr = Array.from(candidates) as string[];
  return {
    summary: `Found ${results.length} results, scraped ${results.filter((r) => r.scraped).length}. ${arr[0] || "No patterns detected"}`,
    solutionCandidates: arr,
    recommendedOrder: arr,
  };
}
