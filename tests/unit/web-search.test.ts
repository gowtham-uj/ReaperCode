import test from "node:test";
import assert from "node:assert/strict";

import { webSearchTool } from "../../src/tools/read/web-search.js";
import { WebSearchArgsSchema } from "../../src/tools/types.js";

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

/**
 * The engine the caller named is the engine that is asked, and the one that
 * answers is the one reported.
 *
 * Both halves were broken. The schema offered `engine` and the implementation
 * discarded it, then hardcoded `engine: "mimo"` in the result — a value not
 * even in the schema's own enum. So `engine: "duckduckgo"` ran all three
 * backends, and the reply claimed a backend that was never consulted.
 */
test("an explicit engine is the only backend queried, and is what the result reports", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.includes("duckduckgo.com")) {
      return textResponse(`<a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/a")}">Example A</a>`);
    }
    return textResponse("<html><body>page body</body></html>");
  };

  const result = await webSearchTool(
    { query: "anything", engine: "duckduckgo", maxResults: 10 },
    { fetchImpl },
  );

  assert.equal(result.engine, "duckduckgo");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.url, "https://example.com/a");
  assert.equal(result.results[0]?.title, "Example A", "the anchor's title is used, not the URL's last segment");
  assert.ok(
    calls.every((url) => !url.includes("serper") && !url.includes("xiaomimimo")),
    `only the requested backend may be contacted, got: ${JSON.stringify(calls)}`,
  );
});

/**
 * An empty search says why, so the model can tell "nothing exists" from
 * "nothing answered".
 *
 * Observed live: `results: []` with no explanation, for queries that plainly
 * have answers, because the keyless backend returned a 202 anti-bot shell that
 * `response.ok` accepted and the parser read as zero results.
 */
test("an empty search reports which backends were consulted", async () => {
  const fetchImpl = async () => textResponse("<html><body>no results here</body></html>");
  const result = await webSearchTool({ query: "nothing matches this", engine: "duckduckgo", maxResults: 10 }, { fetchImpl });
  assert.equal(result.results.length, 0);
  assert.ok(result.notes && result.notes.length > 0, "an empty result must explain itself");
  assert.match(result.notes.join("\n"), /duckduckgo/);
});

/**
 * Every engine the schema accepts is one a backend implements.
 *
 * This is a drift guard, not a regression guard, and the distinction is worth
 * stating because an earlier version of this comment overstated it. `brave` is
 * not, and never was, in the accepted enum: the schema has always offered
 * `duckduckgo`, `mimo`, `serper` and `auto`. The bug was never "brave is
 * accepted and ignored" but "the engine argument is accepted and the result
 * hardcodes `mimo`", and that is pinned by the test above, which fails against
 * the pre-fix source.
 *
 * What this pins is the property that let the bug hide: the schema and the
 * reported union have to name the same set. A future `brave` added to one and
 * not the other fails here rather than in a user's silent fallback.
 */
test("every engine the schema accepts is one the result can report", async () => {
  const accepted = ["duckduckgo", "mimo", "serper"];
  for (const engine of accepted) {
    assert.equal(WebSearchArgsSchema.safeParse({ query: "q", engine }).success, true, `${engine} must be accepted`);
  }
  /* `auto` is a choice about strategy, not a backend, so it is not reportable. */
  assert.equal(WebSearchArgsSchema.safeParse({ query: "q", engine: "auto" }).success, true);
  assert.equal(WebSearchArgsSchema.safeParse({ query: "q", engine: "brave" }).success, false, "an unimplemented backend must not be accepted");

  const fetchImpl = async (url: string) =>
    url.includes("duckduckgo.com")
      ? textResponse(`<a class="result__a" href="https://example.com/x">X</a>`)
      : textResponse("<html><body>body</body></html>");
  const result = await webSearchTool({ query: "q", engine: "duckduckgo", maxResults: 10 }, { fetchImpl });
  assert.ok(
    accepted.includes(result.engine),
    `the reported engine must be an implemented backend, got: ${result.engine}`,
  );
});
