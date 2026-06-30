#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const OB = '{';
const CB = '}';

function typeParams(s) {
  return LT + s + GT;
}

// Build file line by line to avoid template escaping hell
const lines = [];

lines.push('import { randomUUID } from "node:crypto";');
lines.push('');
lines.push('interface SearchResult {');
lines.push('  title: string;');
lines.push('  url: string;');
lines.push('  snippet?: string;');
lines.push('}');
lines.push('');
lines.push('export interface WebSearchArgs {');
lines.push('  query: string;');
lines.push('  engine?: "duckduckgo" | "brave" | "auto";');
lines.push('  maxResults?: number;');
lines.push('  scrapePages?: number;');
lines.push('}');
lines.push('');
lines.push('export interface WebSearchResult {');
lines.push('  query: string;');
lines.push('  engine: "mimo" | "serper" | "duckduckgo";');
lines.push('  searchedAt: string;');
lines.push('  requestedPages: number;');
lines.push('  scrapedPages: number;');
lines.push('  results: ' + OB);
lines.push('    title: string;');
lines.push('    url: string;');
lines.push('    snippet?: string;');
lines.push('    scraped: boolean;');
lines.push('    summary?: string;');
lines.push('    error?: string;');
lines.push('  ' + CB + '[];');
lines.push('  synthesis: {');
lines.push('    summary: string;');
lines.push('    solutionCandidates: string[];');
lines.push('    recommendedOrder: string[];');
lines.push('  };');
lines.push('}');
lines.push('');

// Main function
lines.push('export async function webSearchTool(');
lines.push('  args: WebSearchArgs,');
lines.push('  options: { fetchImpl?: any; now?: Date } = {},');
lines.push('): Promise' + typeParams('WebSearchResult') + ' {');
lines.push('  const fetchImpl = options.fetchImpl ?? (fetch as any);');
lines.push('  const query = args.query;');
lines.push('  const maxResults = args.maxResults ?? 10;');
lines.push('  const [mimoR, serperR, ddgR] = await Promise.all([');
lines.push('    searchMiMo(query, maxResults, fetchImpl).catch(() => []),');
lines.push('    searchSerper(query, maxResults, fetchImpl).catch(() => []),');
lines.push('    searchDuckDuckGo(query, maxResults, fetchImpl).catch(() => []),');
lines.push('  ]);');
lines.push('  const allResults = dedupeByUrl([...mimoR, ...serperR, ...ddgR]).slice(0, maxResults);');
lines.push('  const scraped = await Promise.all(');
lines.push('    allResults.slice(0, Math.min(maxResults, 10)).map(async (result) => {');
lines.push('      try {');
lines.push('        const html = await fetchText(result.url, fetchImpl, 15_000);');
lines.push('        return { ...result, scraped: true, summary: summarizePage(extractReadableText(html), query) };');
lines.push('      } catch (error) {');
lines.push('        return { ...result, scraped: false, error: error instanceof Error ? error.message : String(error) };');
lines.push('      }');
lines.push('    }),');
lines.push('  );');
lines.push('  const synthesis = synthesizeResearch(query, scraped);');
lines.push('  return { query, engine: "mimo", searchedAt: new Date().toISOString(),');
lines.push('    requestedPages: maxResults, scrapedPages: scraped.filter(s => s.scraped).length,');
lines.push('    results: scraped, synthesis };');
lines.push('}');
lines.push('');

// MiMo
lines.push('async function searchMiMo(query: string, maxResults: number, fetchImpl: any): Promise' + typeParams('SearchResult[]') + ' {');
lines.push('  const apiKey = process.env.MIMO_SEARCH_API_KEY || "";');
lines.push('  if (!apiKey) return [];');
lines.push('  try {');
lines.push('    const response = await fetchWithTimeout("https://api.xiaomimimo.com/v1/chat/completions", fetchImpl, 20_000, {');
lines.push('      method: "POST",');
lines.push('      headers: { "api-key": apiKey, "Content-Type": "application/json" },');
lines.push('      body: JSON.stringify({ model: "mimo-v2.5-pro",');
lines.push('        messages: [{ role: "user", content: query }],');
lines.push('        tools: [{ type: "web_search", max_keyword: 5, force_search: true, limit: maxResults }],');
lines.push('        max_completion_tokens: 2048, temperature: 1.0, top_p: 0.95, stream: false,');
lines.push('        thinking: { type: "disabled" },');
lines.push('      }),');
lines.push('    });');
lines.push('    if (!response.ok) return [];');
lines.push('    const data = await response.json() as any;');
lines.push('    const message = data.choices?.[0]?.message;');
lines.push('    const results: SearchResult[] = [];');
lines.push('    if (Array.isArray(message?.annotations)) {');
lines.push('      for (const ann of message.annotations) {');
lines.push('        if (ann.type === "url_citation" && ann.url) {');
lines.push('          results.push({ title: ann.title || ann.url, url: ann.url, snippet: ann.summary || "" });');
lines.push('        }');
lines.push('      }');
lines.push('    }');
lines.push('    return dedupeByUrl(results).slice(0, maxResults);');
lines.push('  } catch { return []; }');
lines.push('}');
lines.push('');

// Serper
lines.push('async function searchSerper(query: string, maxResults: number, fetchImpl: any): Promise' + typeParams('SearchResult[]') + ' {');
lines.push('  const apiKey = process.env.SERPER_SEARCH_API_KEY || "";');
lines.push('  if (!apiKey) return [];');
lines.push('  try {');
lines.push('    const response = await fetchWithTimeout("https://google.serper.dev/search", fetchImpl, 10_000, {');
lines.push('      method: "POST",');
lines.push('      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },');
lines.push('      body: JSON.stringify({ q: query, num: maxResults }),');
lines.push('    });');
lines.push('    if (!response.ok) return [];');
lines.push('    const data = await response.json() as any;');
lines.push('    const results: SearchResult[] = [];');
lines.push('    for (const item of (data.organic || [])) {');
lines.push('      if (item.link && item.title) results.push({ title: item.title, url: item.link, snippet: item.snippet || "" });');
lines.push('    }');
lines.push('    return results.slice(0, maxResults);');
lines.push('  } catch { return []; }');
lines.push('}');
lines.push('');

// DuckDuckGo
lines.push('async function searchDuckDuckGo(query: string, maxResults: number, fetchImpl: any): Promise' + typeParams('SearchResult[]') + ' {');
lines.push('  try {');
lines.push('    const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", fetchImpl, 10_000, {');
lines.push('      method: "POST",');
lines.push('      headers: { "Content-Type": "application/x-www-form-urlencoded",');
lines.push('        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },');
lines.push('      body: "q=" + encodeURIComponent(query),');
lines.push('    });');
lines.push('    if (!response.ok) return [];');
lines.push('    return parseDDGResults(await response.text(), maxResults);');
lines.push('  } catch { return []; }');
lines.push('}');
lines.push('');

// parseDDGResults
lines.push('function parseDDGResults(html: string, maxResults: number): SearchResult[] {');
lines.push('  const results: SearchResult[] = [];');
lines.push('  const urls = [...new Set([...(html.match(/uddg=([^&"]+)/g) || [])])];');
lines.push('  for (let i = 0; i ' + LT + ' urls.length && results.length ' + LT + ' maxResults; i++) {');
lines.push('    try {');
lines.push('      const url = decodeURIComponent(urls[i].replace("uddg=", ""));');
lines.push('      if (url.startsWith("http")) results.push({ title: url.split("/").pop() || url, url, snippet: "" });');
lines.push('    } catch {}');
lines.push('  }');
lines.push('  return results;');
lines.push('}');
lines.push('');

// dedupeByUrl
lines.push('function dedupeByUrl(results: SearchResult[]): SearchResult[] {');
lines.push('  const seen = new Set' + typeParams('string') + '();');
lines.push('  return results.filter((r) => { const k = r.url.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });');
lines.push('}');
lines.push('');

// fetchText
lines.push('async function fetchText(url: string, fetchImpl: any, timeoutMs: number): Promise' + typeParams('string') + ' {');
lines.push('  const controller = new AbortController();');
lines.push('  const timeout = setTimeout(() => controller.abort(), timeoutMs);');
lines.push('  try { return await fetchImpl(url, { signal: controller.signal,');
lines.push('    headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" } }); }');
lines.push('  finally { clearTimeout(timeout); }');
lines.push('}');
lines.push('');

// fetchWithTimeout
lines.push('async function fetchWithTimeout(url: string, fetchImpl: any, timeoutMs: number, init: any): Promise' + typeParams('any') + ' {');
lines.push('  const controller = new AbortController();');
lines.push('  const timeout = setTimeout(() => controller.abort(), timeoutMs);');
lines.push('  try { return await fetchImpl(url, { ...init, signal: controller.signal }); }');
lines.push('  finally { clearTimeout(timeout); }');
lines.push('}');
lines.push('');

// extractReadableText
lines.push('function extractReadableText(html: string): string {');
lines.push('  return html');
lines.push("    .replace(/