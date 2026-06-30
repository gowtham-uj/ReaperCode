import test from "node:test";
import assert from "node:assert/strict";

import { parseJsonRpcRequest, parseJsonRpcResponse } from "../../src/connection/json-rpc.js";

test("parses a valid JSON-RPC request", () => {
  const request = parseJsonRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "agent.request",
    params: { ok: true },
  });

  assert.equal(request.id, 1);
});

test("rejects JSON-RPC responses with both result and error", () => {
  assert.throws(
    () =>
      parseJsonRpcResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: 1, message: "bad" },
      }),
    /cannot contain both result and error/,
  );
});

test("rejects JSON-RPC responses with neither result nor error", () => {
  assert.throws(
    () =>
      parseJsonRpcResponse({
        jsonrpc: "2.0",
        id: 1,
      }),
    /must contain either result or error/,
  );
});
