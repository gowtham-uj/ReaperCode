import { test } from "node:test";
import assert from "node:assert/strict";

import { getPreferredStructuredMode } from "../../src/model/response-adapter.js";

test("getPreferredStructuredMode: MiniMax-M3 defaults to provider_json", () => {
  assert.equal(getPreferredStructuredMode("minimax", "MiniMax-M3", "secondary_model"), "provider_json");
});

test("getPreferredStructuredMode: non-MiniMax providers keep historical undefined default", () => {
  assert.equal(getPreferredStructuredMode("deepseek", "deepseek-chat", "secondary_model"), undefined);
});
