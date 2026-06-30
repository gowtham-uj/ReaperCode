import test from "node:test";
import assert from "node:assert/strict";

import {
  parseResourceSource,
  resolveResourcePath,
  sourceMatchKeyForInput,
  sourceMatchKeyForSettings,
} from "../../src/resources/source-parser.js";

test("parseResourceSource parses npm packages and exact pins", () => {
  assert.deepEqual(parseResourceSource("npm:@scope/pkg@1.2.3"), {
    type: "npm",
    spec: "@scope/pkg@1.2.3",
    name: "@scope/pkg",
    version: "1.2.3",
    pinned: true,
  });

  assert.deepEqual(parseResourceSource("npm: left-pad@^1.3.0"), {
    type: "npm",
    spec: "left-pad@^1.3.0",
    name: "left-pad",
    version: "^1.3.0",
    pinned: false,
  });

  assert.deepEqual(parseResourceSource("npm:typescript"), {
    type: "npm",
    spec: "typescript",
    name: "typescript",
    version: undefined,
    pinned: false,
  });
});

test("parseResourceSource parses git shorthand, protocol URLs, scp-like URLs, GitHub shorthands, and refs", () => {
  assert.deepEqual(parseResourceSource("git:github.com/acme/reaper-tools@main"), {
    type: "git",
    repo: "https://github.com/acme/reaper-tools",
    host: "github.com",
    path: "acme/reaper-tools",
    ref: "main",
    pinned: true,
  });

  assert.deepEqual(parseResourceSource("github:acme/reaper-tools@v2"), {
    type: "git",
    repo: "https://github.com/acme/reaper-tools",
    host: "github.com",
    path: "acme/reaper-tools",
    ref: "v2",
    pinned: true,
  });

  assert.deepEqual(parseResourceSource("https://github.com/acme/reaper-tools@v1"), {
    type: "git",
    repo: "https://github.com/acme/reaper-tools",
    host: "github.com",
    path: "acme/reaper-tools",
    ref: "v1",
    pinned: true,
  });

  assert.deepEqual(parseResourceSource("git@github.com:acme/reaper-tools@feature/foo"), {
    type: "git",
    repo: "git@github.com:acme/reaper-tools",
    host: "github.com",
    path: "acme/reaper-tools",
    ref: "feature/foo",
    pinned: true,
  });
});

test("parseResourceSource rejects unsafe git install parts", () => {
  const unsafe = [
    "git:github.com/acme/../evil",
    "git:github.com/acme/reaper\\evil",
    "git:github.com/acme/%2e%2e/evil",
    "git:github.com/acme/%5Cevil",
    "git:/absolute/path",
    "github:acme/../evil",
    "github:acme/%2e%2e/evil",
    "github:/absolute/path",
  ];

  for (const source of unsafe) {
    assert.equal(parseResourceSource(source), null, source);
  }
});

test("parseResourceSource treats file URLs and bare paths as local resources", () => {
  assert.deepEqual(parseResourceSource("./.reaper/extensions/foo"), {
    type: "local",
    path: "./.reaper/extensions/foo",
  });
  assert.deepEqual(parseResourceSource("file:///tmp/reaper-ext"), {
    type: "local",
    path: "/tmp/reaper-ext",
  });
  assert.deepEqual(parseResourceSource("~/reaper-ext"), {
    type: "local",
    path: "~/reaper-ext",
  });
});

test("resource source match keys dedupe package identity by npm name, git host/path, and resolved local path", () => {
  assert.equal(sourceMatchKeyForInput("npm:@scope/pkg@1.2.3"), "npm:@scope/pkg");
  assert.equal(sourceMatchKeyForInput("npm:@scope/pkg@^2.0.0"), "npm:@scope/pkg");

  assert.equal(sourceMatchKeyForInput("git:github.com/acme/reaper-tools@main"), "git:github.com/acme/reaper-tools");
  assert.equal(sourceMatchKeyForInput("https://github.com/acme/reaper-tools@v1"), "git:github.com/acme/reaper-tools");

  assert.equal(
    sourceMatchKeyForSettings("./extensions/foo", "/workspace/repo/.reaper"),
    `local:${resolveResourcePath("./extensions/foo", "/workspace/repo/.reaper")}`,
  );
});
