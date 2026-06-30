#!/usr/bin/env python3
"""Generate the implementation part of web-search.ts"""
import sys

LT = chr(60)
GT = chr(62)
def L(s): return LT + s + GT

impl = f"""
export async function webSearchTool(
  args: WebSearchArgs,
  options: {{ fetchImpl?: any; now?: Date }} = {{}},
): Promise{L("WebSearchResult")} {{
  const fetchImpl = options.fetchImpl ?? (fetch as any);
  const query = args.query;
  const maxResults = args.maxResults ?? 10;

  // Run 3 search engines in PARALLEL
  const [mimoResults, serperResults, ddgResults] = await Promise.all([
    searchMiMo(query, maxResults, fetchImpl),
    searchSerper(query, maxResults, fetchImpl),
    searchDuckDuckGo(query, maxResults, fetchImpl),
  ]);

  const allResults = dedupeByUrl([...mimoResults, ...serperResults, ...ddgResults]).slice(0, maxResults);

  // Scrape pages for content
  const scraped = await Promise.all(
    allResults.slice(0, Math.min(maxResults, 10)).map(async (result) => {{
      try {{
        const html = await fetchText(result.url, fetchImpl, 15_000);
        return {{ ...result, scraped: true, summary: summarizePage(extractReadableText(html), query) }};
      }} catch (error) {{
        return {{ ...result, scraped: false, error: error instanceof Error ? error.message : String(error) }};
      }}
    }}),
  );

  const synthesis = synthesizeResearch(query, scraped);
  return {{
    query, engine: "mimo",
    searchedAt: new Date().toISOString(),
    requestedPages: maxResults,
    scrapedPages: scraped.filter((s) => s.scraped).length,
    results: scraped, synthesis,
  }};
}}

// ===== MiMo AI Search =====
async function searchMiMo(query: string, maxResults: number, fetchImpl: any): Promise{L("SearchResult[]")} {{
  const apiKey = process.env.MIMO_SEARCH_API_KEY || "";
  if (!apiKey) return [];
  try {{
    const response = await fetchWithTimeout("https://api.xiaomimimo.com/v1/chat/completions", fetchImpl, 20_000, {{
      method: "POST",
      headers: {{ "api-key": apiKey, "Content-Type": "application/json" }},
      body: JSON.stringify({{
        model: "mimo-v2.5-pro",
        messages: [{{ role: "user", content: query }}],
        tools: [{{ type: "web_search", max_keyword: 5, force_search: true, limit: maxResults }}],
        max_completion_tokens: 2048, temperature: 1.0, top_p: 0.95, stream: false,
        thinking: {{ type: "disabled" }},
      }}),
    }});
    if (!response.ok) return [];
    const data = await response.json() as any;
    const message = data.choices?.[0]?.message;
    const results: SearchResult[] = [];
    if (Array.isArray(message?.annotations)) {{
      for (const ann of message.annotations) {{
        if (ann.type === "url_citation" && ann.url) {{
          results.push({{ title: ann.title || ann.url, url: ann.url, snippet: ann.summary || "" }});
        }}
      }}
    }}
    return dedupeByUrl(results).slice(0, maxResults);
  }} catch {{
    return [];
  }}
}}

// ===== Serper.dev Google Search =====
async function searchSerper(query: string, maxResults: number, fetchImpl: any): Promise{L("SearchResult[]")} {{
  const apiKey = process.env.SERPER_SEARCH_API_KEY || "";
  if (!apiKey) return [];
  try {{
    const response = await fetchWithTimeout("https://google.serper.dev/search", fetchImpl, 10_000, {{
      method: "POST",
      headers: {{ "X-API-KEY": apiKey, "Content-Type": "application/json" }},
      body: JSON.stringify({{ q: query, num: maxResults }}),
    }});
    if (!response.ok) return [];
    const data = await response.json() as any;
    const results: SearchResult[] = [];
    for (const item of (data.organic || [])) {{
      if (item.link && item.title) {{
        results.push({{ title: item.title, url: item.link, snippet: item.snippet || "" }});
      }}
    }}
    return results.slice(0, maxResults);
  }} catch {{
    return [];
  }}
}}

// ===== DuckDuckGo Free Search =====
async function searchDuckDuckGo(query: string, maxResults: number, fetchImpl: any): Promise{L("SearchResult[]")} {{
  try {{
    const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", fetchImpl, 10_000, {{
      method: "POST",
      headers: {{ "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" }},
      body: "q=" + encodeURIComponent(query),
    }});
    if (!response.ok) return [];
    return parseDDGResults(await response.text(), maxResults);
  }} catch {{
    return [];
  }}
}}

function parseDDGResults(html: string, maxResults: number): SearchResult[] {{
  const results: SearchResult[] = [];
  const urls = [...new Set([...(html.match(/uddg=([^&"]+)/g) || [])])];
  for (let i = 0; i {LT} urls.length && results.length {LT} maxResults; i++) {{
    try {{
      const url = decodeURIComponent(urls[i].replace("uddg=", ""));
      if (url.startsWith("http")) results.push({{ title: url.split("/").pop() || url, url, snippet: "" }});
    }} catch {{}}
  }}
  return results;
}}

// ===== Deduplication =====
function dedupeByUrl(results: SearchResult[]): SearchResult[] {{
  const seen = new Set{L("string")}();
  return results.filter((r) => {{ const k = r.url.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }});
}}

// ===== HTTP helpers =====
async function fetchText(url: string, fetchImpl: any, timeoutMs: number): Promise{L("string")} {{
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {{
    const response = await fetchImpl(url, {{
      signal: controller.signal,
      headers: {{ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" }},
    }});
    return await response.text();
  }} finally {{ clearTimeout(timeout); }}
}}

async function fetchWithTimeout(url: string, fetchImpl: any, timeoutMs: number, init: any): Promise{L("any")} {{
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {{ return await fetchImpl(url, {{ ...init, signal: controller.signal }}); }}
  finally {{ clearTimeout(timeout); }}
}}

// ===== HTML parsing =====
function extractReadableText(html: string): string {{
  return html
    .replace(/