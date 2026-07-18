import test from "node:test";
import assert from "node:assert/strict";

import { classifyTestFileDiff } from "../../src/eval/test-diff.js";

const ORIGINAL = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "./isPalindrome.js";

test("palindrome detection", () => {
  assert.equal(isPalindrome("A man a plan a canal Panama"), true);
  assert.equal(isPalindrome("hello"), false);
});

test("empty string is a palindrome", () => {
  assert.equal(isPalindrome(""), true);
});
`;

test("identical test files are reported as identical", () => {
  const result = classifyTestFileDiff(ORIGINAL, ORIGINAL);
  assert.equal(result.kind, "identical");
  assert.equal(result.originalNames.length, 2);
  assert.equal(result.modifiedNames.length, 2);
  assert.deepEqual(result.addedNames, []);
  assert.deepEqual(result.removedNames, []);
  assert.deepEqual(result.changedNames, []);
});

test("adding new tests without touching existing ones is extended", () => {
  const modified = `${ORIGINAL}

test("case insensitive punctuation", () => {
  assert.equal(isPalindrome("Racecar"), true);
  assert.equal(isPalindrome("No lemon, no melon"), true);
});
`;
  const result = classifyTestFileDiff(ORIGINAL, modified);
  assert.equal(result.kind, "extended");
  assert.deepEqual(result.addedNames, ["case insensitive punctuation"]);
  assert.deepEqual(result.removedNames, []);
  assert.deepEqual(result.changedNames, []);
  assert.deepEqual(result.loosenedNames, []);
});

test("removing a test is weakened", () => {
  const modified = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "./isPalindrome.js";

test("palindrome detection", () => {
  assert.equal(isPalindrome("A man a plan a canal Panama"), true);
  assert.equal(isPalindrome("hello"), false);
});
`;
  const result = classifyTestFileDiff(ORIGINAL, modified);
  assert.equal(result.kind, "weakened");
  assert.deepEqual(result.removedNames, ["empty string is a palindrome"]);
});

test("loosening an assertion (equal -> ok) is weakened", () => {
  const modified = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "./isPalindrome.js";

test("palindrome detection", () => {
  assert.ok(isPalindrome("A man a plan a canal Panama"));
  assert.ok(!isPalindrome("hello"));
});

test("empty string is a palindrome", () => {
  assert.equal(isPalindrome(""), true);
});
`;
  const result = classifyTestFileDiff(ORIGINAL, modified);
  assert.equal(result.kind, "weakened");
  assert.deepEqual(result.changedNames, ["palindrome detection"]);
  assert.deepEqual(result.loosenedNames, ["palindrome detection"]);
});

test("changing an assertion to a stricter one is mutated, not weakened", () => {
  const modified = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "./isPalindrome.js";

test("palindrome detection", () => {
  assert.strictEqual(isPalindrome("A man a plan a canal Panama"), true);
  assert.strictEqual(isPalindrome("hello"), false);
});

test("empty string is a palindrome", () => {
  assert.equal(isPalindrome(""), true);
});
`;
  const result = classifyTestFileDiff(ORIGINAL, modified);
  assert.equal(result.kind, "mutated");
  assert.deepEqual(result.loosenedNames, []);
});

test("mixing additions and removals is weakened", () => {
  const modified = `import { test } from "node:test";
import assert from "node:assert/strict";
import { isPalindrome } from "./isPalindrome.js";

test("palindrome detection", () => {
  assert.equal(isPalindrome("A man a plan a canal Panama"), true);
  assert.equal(isPalindrome("hello"), false);
});

test("brand new edge case", () => {
  assert.equal(isPalindrome("x"), true);
});
`;
  const result = classifyTestFileDiff(ORIGINAL, modified);
  assert.equal(result.kind, "weakened");
  assert.deepEqual(result.removedNames, ["empty string is a palindrome"]);
});