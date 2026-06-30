import test from "node:test";
import assert from "node:assert/strict";

import { webSearchTool } from "../../src/tools/read/web-search.js";

test("web search scrapes ten requested results and synthesizes repair candidates", async () => {
  const searchHtml = Array.from({ length: 10 }, (_, index) => {
    const page = index + 1;
    const href = `https://duckduckgo.com/l/?uddg=${encodeURIComponent(`https://example.com/page-${page}`)}`;
    return `<div class="result"><a class="result__a" href="${href}">Result ${page}</a><a class="result__snippet">ts-jest beforeAll expect TypeScript setup ${page}</a></div>`;
  }).join("\n");

  const fetchImpl = async (url: string) => {
    if (url.includes("duckduckgo.com/html")) {
      return textResponse(searchHtml);
    }
    const pageText = "<html><body>Install jest ts-jest @types/jest and add jest node to tsconfig types. Fix beforeAll expect errors.</body></html>";
    return textResponse(pageText);
  };

  const result = await webSearchTool(
    { query: "fix ts-jest beforeAll expect TypeScript", engine: "duckduckgo", maxResults: 10, scrapePages: 10 },
    { fetchImpl, now: new Date("2026-05-08T00:00:00.000Z") },
  );

  assert.ok(["mimo", "serper", "duckduckgo"].includes(result.engine));
  assert.equal(result.requestedPages, 10);
  assert.equal(result.scrapedPages, 10);
  assert.equal(result.results.length, 10);
  assert.match(result.synthesis.solutionCandidates.join("\n"), /jest|ts-jest|@types\/jest/i);
});

function textResponse(body: string) {
  return {
    ok: true,
    status: 200,
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}
