import { test } from "node:test";
import assert from "node:assert/strict";

import { RunLedger } from "../../../../src/browser/runtime/run-ledger.js";
import { renderVerification, verify } from "../../../../src/browser/runtime/verifier.js";

test("a file that exists without a download event does not satisfy a provenance requirement", () => {
  /*
   * The violation this is written for: an invoice that reached the vault after
   * being fetched over HTTP rather than downloaded. Both leave a file; only one
   * performed the interaction.
   */
  const ledger = new RunLedger();
  ledger.record({ kind: "artifact.saved", name: "invoice.txt", path: "/w/invoice.txt", bytes: 66, announced: false });
  const outcome = verify([{ kind: "artifactFromAction", name: "invoice" }], { ledger });
  assert.equal(outcome.passed, false);
  assert.match(outcome.missing[0] ?? "", /download event/);
});

test("a click-opened popup satisfies a popup requirement and a manual tab does not", () => {
  const manual = new RunLedger();
  manual.record({ kind: "page.created", pageId: "p9", creationType: "newPage", url: "https://the-internet.herokuapp.com/windows/new" });
  assert.equal(verify([{ kind: "popup", pattern: "windows/new" }], { ledger: manual }).passed, false);

  const clicked = new RunLedger();
  clicked.record({ kind: "page.created", pageId: "p9", creationType: "popup", openedBy: "a152", url: "https://the-internet.herokuapp.com/windows/new" });
  assert.equal(verify([{ kind: "popup", pattern: "windows/new" }], { ledger: clicked }).passed, true);
});

test("completion is all-or-nothing, and a failure names every missing requirement", () => {
  const ledger = new RunLedger();
  ledger.record({ kind: "mission.started" });
  const outcome = verify(
    [
      { kind: "fact", name: "version", value: "1.63.0" },
      { kind: "url", pattern: "/parabank" },
      { kind: "artifact", name: "invoice" },
    ],
    { ledger, url: "https://example.com/", facts: new Map([["version", "1.63.0"]]) },
  );
  assert.equal(outcome.passed, false);
  assert.equal(outcome.results.filter((result) => result.passed).length, 1);
  assert.equal(outcome.missing.length, 2);
  assert.match(renderVerification(outcome), /The mission is not finished/);
});

test("a passing verification is one line, because a finished mission needs no report", () => {
  const ledger = new RunLedger();
  const outcome = verify([{ kind: "url", pattern: "parabank" }], { ledger, url: "https://parabank.parasoft.com/parabank/index.htm" });
  assert.equal(outcome.passed, true);
  assert.equal(renderVerification(outcome).split("\n").length, 1);
});

test("a plain path pattern is a substring, so no regex escaping is required of the caller", () => {
  /*
   * `new RegExp("/parabank")` would be a silent bug in the caller's own manifest.
   * A pattern with no regex metacharacters is matched literally.
   */
  const ledger = new RunLedger();
  assert.equal(verify([{ kind: "url", pattern: "/index.htm" }], { ledger, url: "https://x/parabank/index.htm" }).passed, true);
  assert.equal(verify([{ kind: "url", pattern: "(unclosed" }], { ledger, url: "https://x/(unclosed" }).passed, true);
});
