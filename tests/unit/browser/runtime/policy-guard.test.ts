import { test } from "node:test";
import assert from "node:assert/strict";

import { inspectProgram, renderPolicyReport } from "../../../../src/browser/runtime/policy-guard.js";

test("a fetch inside evaluate is refused, and the report says what to do instead", () => {
  /*
   * The measured violation: a mission fetched an invoice over HTTP and wrote it
   * to disk rather than clicking the download link. The end state was right and
   * the interaction, which is what the task measured, did not happen.
   */
  const report = inspectProgram(
    `const body = await page.evaluate(() => fetch("/download_invoice/1").then(r => r.text()));`,
    "ui-only",
  );
  assert.equal(report.allowed, false);
  assert.ok(report.violations.some((violation) => violation.rule === "evaluate-network"));
  assert.match(renderPolicyReport(report), /instead:/);
});

test("creating a page directly is refused, because the task asked for a click", () => {
  const report = inspectProgram(`const popup = await context.newPage();`, "ui-only");
  assert.equal(report.allowed, false);
  assert.ok(report.violations.some((violation) => violation.rule === "manual-page-creation"));
});

test("evaluate itself stays allowed, because reading is what a browser agent does", () => {
  /*
   * The line that matters. Banning evaluate would push the model to some other
   * door and would make measurement, reading values and scrolling impossible,
   * which is most of what a legitimately interactive program does.
   */
  const report = inspectProgram(
    `const title = await page.evaluate(() => document.title);
const h = await page.evaluate(() => document.body.scrollHeight);
const text = await page.locator("h1").textContent();
await page.getByRole("button", { name: "Download" }).click();`,
    "ui-only",
  );
  assert.equal(report.allowed, true, renderPolicyReport(report));
});

test("the policy is off by default for ordinary browsing", () => {
  const report = inspectProgram(`await fetch("https://api.example.com");`, "none");
  assert.equal(report.allowed, true);
  assert.deepEqual(report.violations, []);
});

test("a violation quotes the line, so the model can find what it wrote", () => {
  const report = inspectProgram(`await page.goto("/a");\nawait page.evaluate(() => fetch("/x"));\nawait page.goto("/b");`, "ui-only");
  assert.match(report.violations[0]?.excerpt ?? "", /fetch/);
  assert.doesNotMatch(report.violations[0]?.excerpt ?? "", /goto\("\/b"\)/);
});
