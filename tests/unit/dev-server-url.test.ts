import test from "node:test";
import assert from "node:assert/strict";

import { detectServerUrls } from "../../src/tools/dev-server-url.js";

test("real dev-server banners are detected", () => {
  const cases: Array<[string, string]> = [
    ["  ➜  Local:   http://localhost:5173/", "http://localhost:5173"],
    ["- Local:        http://localhost:3000", "http://localhost:3000"],
    ["Starting development server at http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
    ["Server running on http://0.0.0.0:8080/api", "http://localhost:8080"],
    ["Listening on https://localhost:4443", "https://localhost:4443"],
  ];
  for (const [line, expected] of cases) {
    assert.equal(detectServerUrls(line)[0]?.url, expected, `failed on: ${line}`);
  }
});

test("only the origin is kept, never the path from the log line", () => {
  // The path is untrusted text; keeping it would append it to proxied requests.
  const found = detectServerUrls("ready at http://localhost:5173/../../admin?x=1");
  assert.equal(found[0]?.url, "http://localhost:5173");
});

test("non-loopback hosts are never offered as a proxy target", () => {
  // A background process that echoes attacker text must not be able to name an
  // arbitrary host for the BFF to fetch.
  for (const line of [
    "fetching http://evil.example.com:8080/payload",
    "http://169.254.169.254:80/latest/meta-data",
    "http://localhost.evil.com:3000",
    "http://10.0.0.5:8000",
  ]) {
    assert.deepEqual(detectServerUrls(line), [], `should not match: ${line}`);
  }
});

test("privileged ports are not treated as dev servers", () => {
  assert.deepEqual(detectServerUrls("http://127.0.0.1:22"), []);
  assert.deepEqual(detectServerUrls("http://localhost:631/printers"), []);
});

test("duplicates collapse and order is first-seen", () => {
  const found = detectServerUrls(
    "Local: http://localhost:5173/\nNetwork: http://localhost:5173/\nAPI: http://127.0.0.1:9000/",
  );
  assert.deepEqual(found.map((entry) => entry.url), [
    "http://localhost:5173",
    "http://127.0.0.1:9000",
  ]);
});

test("ordinary output allocates nothing", () => {
  assert.deepEqual(detectServerUrls("Compiled 42 modules in 310ms"), []);
  assert.deepEqual(detectServerUrls(""), []);
});
