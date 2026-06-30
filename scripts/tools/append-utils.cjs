#!/usr/bin/env node
const fs = require('fs');

const LT = String.fromCharCode(60);
const GT = String.fromCharCode(62);
const EXCL = String.fromCharCode(33);
const DASH = String.fromCharCode(45);

const chunk = `

// ===== Deduplication =====
function dedupeByUrl(results) {
  const seen = new Set${LT}string${GT}();
  return results.filter((r) => {
    const key = r.url.replace(/\\/+$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ===== HTTP Helpers =====
async function fetchText(url, fetchImpl, timeoutMs) {
  for (let attempt = 0; attempt ${LT} 3; attempt++) {
    try {
      const response = await fetchWithTimeout(url, fetchImpl, timeoutMs, {
        headers: {
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        },
      });
      if (response.status === 403) throw new Error('Forbidden');
      if (!response.ok) throw new Error('Status ' + response.status);
      return await response.text();
    } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ===== HTML Parsing =====
function extractReadableText(html) {
  return cleanText(
    decodeHtml(
      stripHtml(
        html
          .replace(/${LT}script[\\s\\S]*?\\/script${GT}/gi, ' ')
          .replace(/${LT}style[\\s\\S]*?\\/style${GT}/gi, ' ')
          .replace(/${LT}noscript[\\s\\S]*?\\/noscript${GT}/gi, ' '),
      ),
    ),
  );
}

function stripHtml(html) {
  return html.replace(/${LT}[^${GT}]+${GT}/g, ' ');
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '${LT}')
    .replace(/&gt;/g, '${GT}')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanText(text) {
  return decodeHtml(text).replace(/\\s+/g, ' ').trim();
}

// ===== CONTEXT-SAFE SUMMARIZATION (max 400 chars per page) =====
function summarizePage(text, query) {
  const terms = query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(t => t.length ${GT} 2);
  // Split by sentence boundaries
  const sentenceEnd = new RegExp('(?=${LT}${EXCL}${DASH})', 'u');
  const sentences = text.split(/(?=\\d+\\.\\s)/).filter(Boolean);
  const scored = sentences.map((sentence, index) => ({
    sentence,
    index,
    score: terms.reduce((score, term) => score + (sentence.toLowerCase().includes(term) ? 1 : 0), 0),
  }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);

  const selected = scored.length ${GT} 0 ? scored : sentences.slice(0, 2);
  // Hard limit: never more than 400 chars per page for context safety
  return selected.join(' ').slice(0, 400);
}

// ===== CONTEXT-SAFE SYNTHESIS (returns concise actionable results) =====
function synthesizeResearch(query, results) {
  const evidence = results
    .filter((item) => item.scraped && !item.error)
    .map((item, index) => '[' + (index + 1) + '] ' + item.title + ': ' + (item.summary || item.snippet || '').slice(0, 200))
    .filter(Boolean)
    .join('\\n');

  const snippets = (query + '\\n' + evidence).toLowerCase();
  const candidates = new Set();

  // Detect common patterns from search results concisely
  if (/jest|ts-jest|typescript|test/.test(snippets)) {
    candidates.add('Test config issue: Check tsconfig, jest.config, and @types/jest compatibility');
  }
  if (/sqlite|glibc|err_dlopen|native|better-sqlite3/.test(snippets)) {
    candidates.add('Native module issue: Use better-sqlite3 or sql.js (pure JS) as fallback');
  }
  if (/timeout|timed out|install|npm/.test(snippets)) {
    candidates.add('Dependency install issue: Split long installs, prefer existing lockfile');
  }
  if (/vite|webpack|react-scripts/.test(snippets)) {
    candidates.add('Build tool issue: Downgrade Vite to v5 or use tsx for dev');
  }
  if (/express|ws|websocket/.test(snippets)) {
    candidates.add('WebSocket setup: Use ws library with express http server, handle upgrade');
  }
  if (/docker|dockerfile|container/.test(snippets)) {
    candidates.add('Docker not available: Use direct node/npm commands, no containerization');
  }
  if (/cors|auth|bcrypt|session/.test(snippets)) {
    candidates.add('Auth/cors issue: Use bcryptjs, express-session, cors middleware');
  }
  if (candidates.size === 0) {
    candidates.add('No specific pattern detected. Apply smallest fix matching the error, then retry.');
  }

  const solutionCandidates = [...candidates];

  // Keep synthesis concise - under 500 chars total for context safety
  return {
    summary: 'Found ' + results.length + ' result(s), scraped ' + results.filter(r => r.scraped).length + ', synthesized ' + solutionCandidates.length + ' solution candidate(s) for: ' + query.slice(0, 80),
    solutionCandidates,
    recommendedOrder: solutionCandidates.map((c, i) => (i + 1) + '. ' + c),
  };
}
`;

const filePath = 'src/tools/read/web-search.ts';
const existing = fs.readFileSync(filePath, 'utf8');
fs.writeFileSync(filePath, existing + chunk);
console.log('Appended utilities. Total size:', fs.readFileSync(filePath, 'utf8').length);
