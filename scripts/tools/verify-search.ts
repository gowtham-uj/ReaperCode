#!/usr/bin/env npx tsx
/**
 * Verify web search tool works end-to-end
 */
import { webSearchTool } from "../../src/tools/read/web-search.js";

async function main() {
  console.log("MIMO SEARCH API KEY:", process.env.MIMO_SEARCH_API_KEY ? "present" : "missing");
  console.log("SERPER SEARCH API KEY:", process.env.SERPER_SEARCH_API_KEY ? "present" : "missing");

  const result = await webSearchTool({
    query: "how to implement Node.js Express WebSocket chat application",
    maxResults: 5,
    scrapePages: 5,
  });

  console.log(`\nEngine used: ${result.engine}`);
  console.log(`Results: ${result.results.length}`);
  for (const r of result.results.slice(0, 3)) {
    console.log(`  - ${r.title}: ${r.url} (scraped: ${r.scraped})`);
  }
  console.log(`\nSynthesis: ${JSON.stringify(result.synthesis, null, 2)}`);
}

main().catch(console.error);
