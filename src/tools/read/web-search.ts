
interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchArgs {
  query: string;
  engine?: "duckduckgo" | "brave" | "auto";
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
}

export async function webSearchTool(
  args: WebSearchArgs,
  options: Record<string, any> = {},
): Promise<WebSearchResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as any);
  const query = args.query;
  const maxResults = args.maxResults ?? 10;

  // Run 3 search engines in PARALLEL
  const [mimoResults, serperResults, ddgResults] = await Promise.all([
    searchMiMo(query, maxResults, fetchImpl).catch(() => [] as SearchResult[]),
    searchSerper(query, maxResults, fetchImpl).catch(() => [] as SearchResult[]),
    searchDuckDuckGo(query, maxResults, fetchImpl).catch(() => [] as SearchResult[]),
  ]);

  // Merge and deduplicate
  const allResults = dedupeByUrl([...mimoResults, ...serperResults, ...ddgResults]).slice(0, maxResults);

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
    engine: "mimo",
    searchedAt: new Date().toISOString(),
    requestedPages: maxResults,
    scrapedPages: scraped.filter((s) => s.scraped).length,
    results: scraped,
    synthesis,
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
async function searchDuckDuckGo(query: string, maxResults: number, fetchImpl: any): Promise<SearchResult[]> {
  try {
    const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", fetchImpl, 10_000, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      },
      body: "q=" + encodeURIComponent(query),
    });
    if (!response.ok) return [];
    return parseDDGResults(await response.text(), maxResults);
  } catch {
    return [];
  }
}

function parseDDGResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const urlMatches = html.match(/uddg=([^&"]+)/g) || [];
  const seen = new Set<string>();
  for (const match of urlMatches) {
    try {
      const url = decodeURIComponent(match.replace("uddg=", ""));
      if (url.startsWith("http") && !seen.has(url)) {
        seen.add(url);
        results.push({ title: url.split("/").pop() || url, url, snippet: "" });
      }
    } catch {}
    if (results.length >= maxResults) break;
  }
  return results;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
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
