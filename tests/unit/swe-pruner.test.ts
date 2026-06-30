import test from "node:test";
import assert from "node:assert/strict";

import { pruneWithSwePruner } from "../../src/context/swe-pruner.js";

test("SWE pruner defaults to local pruning even when a URL is configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("external pruner should not be called in localOnly mode");
  };

  try {
    const code = Array.from({ length: 260 }, (_, index) =>
      index === 140 ? "export function targetRepair() { throw new Error('broken'); }" : `// filler line ${index}`,
    ).join("\n");

    const result = await pruneWithSwePruner({
      config: { enabled: true, localOnly: true, url: "https://example.com/prune", threshold: 0.5 },
      query: "targetRepair broken error",
      code,
    });

    assert.equal(result.source, "swe-pruner-local");
    assert.match(result.prunedCode, /targetRepair/);
    assert.ok(result.leftTokenCount < result.originTokenCount);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
