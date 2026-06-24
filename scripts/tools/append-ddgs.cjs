#!/usr/bin/env node
const fs = require('fs');

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);

const chunk = `

// ===== DuckDuckGo Free Search =====
async function searchDuckDuckGo(query, maxResults, fetchImpl) {
  try {
    const response = await fetchWithTimeout('https://html.duckduckgo.com/html/', fetchImpl, 10000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
      body: 'q=' + encodeURIComponent(query),
    });
    if (!response.ok) return await searchDDGGet(query, maxResults, fetchImpl);
    const html = await response.text();
    return parseDDGHtml(html, maxResults);
  } catch {
    return await searchDDGGet(query, maxResults, fetchImpl);
  }
}

async function searchDDGGet(query, maxResults, fetchImpl) {
  try {
    const html = await fetchText('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), fetchImpl, 10000);
    return parseDDGHtml(html, maxResults);
  } catch {
    return [];
  }
}

function parseDDGHtml(html, maxResults) {
  const results = [];
  const resultBlocks = html.match(/class="result__body"[\\s\\S]*?(?=class="result__body"|$)/g) || [];
  for (const block of resultBlocks) {
    const urlMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/>\\s*([^${LT}]+)\\s*${LT}\\/a${GT}/);
    const snippetMatch = block.match(/class="result__snippet"[^${GT}]*${GT}\\s*([^${LT}]+)\\s*${LT}/);
    if (urlMatch && titleMatch) {
      const url = decodeDDGUrl(decodeHtml(urlMatch[1]));
      const title = cleanText(stripHtml(titleMatch[1]));
      const snippet = snippetMatch ? cleanText(stripHtml(snippetMatch[1])) : '';
      if (url && title) results.push({ title, url, snippet });
    }
    if (results.length >= maxResults) break;
  }
  return results;
}

function decodeDDGUrl(rawUrl) {
  try {
    const absolute = rawUrl.startsWith('//') ? 'https:' + rawUrl : rawUrl;
    const parsed = new URL(absolute, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : parsed.href;
  } catch {
    return rawUrl;
  }
}
`;

const filePath = 'src/tools/read/web-search.ts';
const existing = fs.readFileSync(filePath, 'utf8');
fs.writeFileSync(filePath, existing + chunk);
console.log('Appended DuckDuckGo search. Total size:', fs.readFileSync(filePath, 'utf8').length);
