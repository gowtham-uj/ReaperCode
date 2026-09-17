/**
 * The learned site graph.
 *
 * Three properties are load-bearing and each is a way this goes wrong in
 * production rather than in a demo:
 *
 *   - the file is shared across threads, so nothing typed may reach it
 *   - an edge is recorded only when the checks passed, or the graph fills with
 *     transitions the model believed it made
 *   - states come from the page, not the URL, or the graph recognises nothing on
 *     any site with a tenant id
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TransitionDb, generaliseProgram, stateSignature } from "../../../src/browser/transition-db.js";

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reaper-flows-"));
  return join(dir, "flows.json");
}

test("a typed value never reaches the shared file", () => {
  /*
   * The property this file exists for. Flows are shared across threads because a
   * site's shape is not per task, and a password in a shared file is not
   * recoverable the way a lost flow is.
   */
  const generalised = generaliseProgram(`
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("hunter2-secret");
    await page.getByRole("button", { name: "Sign in" }).click();
  `);

  assert.doesNotMatch(generalised, /ada@example\.com/, "an email must not survive");
  assert.doesNotMatch(generalised, /hunter2-secret/, "a password must not survive");
  /*
   * What makes it a recipe survives: the calls, the roles, the label text.
   *
   * A *button name* is a value like any other under this rule, and it is
   * replaced. That is deliberate: `"Sign in"` and `"hunter2-secret"` are the same
   * shape, and a rule that keeps one keeps the other. The recipe is still
   * readable and still useful, because the labels it resolves through survive.
   */
  assert.match(generalised, /getByRole\("button"/, "the structure must survive or the edge is useless");
  assert.match(generalised, /getByLabel\("Email"\)/, "and so must the labels it resolves through");
  assert.match(generalised, /<value>/, "with the typed values replaced");
});

test("selectors and roles survive generalisation", () => {
  // These are the recipe. Losing them would make every stored edge unusable.
  const generalised = generaliseProgram(`await page.locator("#apply").click(); await page.getByTestId("submit").click();`);
  assert.match(generalised, /#apply/);
  assert.match(generalised, /submit/);
});

test("a page state ignores counts, so a list that changes is the same state", () => {
  /*
   * "Results (30)" and "Results (12)" are the same page with different data.
   * Treating them as different states makes the graph useless on every list.
   */
  const a = stateSignature([{ kind: "results", label: "Results (30)" }]);
  const b = stateSignature([{ kind: "results", label: "Results (12)" }]);
  assert.equal(a, b);
});

test("a page state ignores the order its sections are in", () => {
  // A site that reorders its navigation between requests is not in two states.
  const a = stateSignature([{ kind: "navigation", label: "Nav" }, { kind: "form", label: "Apply" }]);
  const b = stateSignature([{ kind: "form", label: "Apply" }, { kind: "navigation", label: "Nav" }]);
  assert.equal(a, b);
});

test("an edge is recorded only when the step succeeded", () => {
  /*
   * The rule that keeps the graph honest. Recording a failure as a transition
   * fills it with paths that do not work, and a model following those is worse
   * off than one exploring from scratch.
   */
  const db = new TransitionDb({ path: "/tmp/unused-for-this-test.json" });
  return db
    .record({ host: "x", from: "a", to: "b", program: "click Continue", succeeded: false })
    .then(() => db.edgesFrom("x", "a"))
    .then((edges) => {
      assert.equal(edges.length, 0, "a failed attempt must not create an edge");
    });
});

test("a repeated failure demotes an edge rather than deleting it", async () => {
  /*
   * A site that changed should be relearnable, not refused. Demotion keeps the
   * program available as a last resort while the model explores past it.
   */
  const db = new TransitionDb({ path: await tempPath() });
  await db.record({ host: "x", from: "a", to: "b", program: "click Continue", succeeded: true });
  assert.equal((await db.edgesFrom("x", "a")).length, 1);

  for (let i = 0; i < 5; i++) await db.record({ host: "x", from: "a", to: "b", program: "click Continue", succeeded: false });
  assert.equal((await db.edgesFrom("x", "a")).length, 0, "a repeatedly failing edge stops being offered");
});

test("a well used edge outranks a rarely used one", async () => {
  const db = new TransitionDb({ path: await tempPath() });
  await db.record({ host: "x", from: "a", to: "b", program: "click Rarely", succeeded: true });
  for (let i = 0; i < 4; i++) await db.record({ host: "x", from: "a", to: "c", program: "click Often", succeeded: true });

  const edges = await db.edgesFrom("x", "a");
  assert.equal(edges[0]?.to, "c", "the program that has worked most often comes first");
});

test("what is written to disk is what is read back", async () => {
  // The round trip, including the generalisation, since that is what the next
  // process actually sees.
  const path = await tempPath();
  const first = new TransitionDb({ path });
  await first.record({ host: "example.com", from: "s1", to: "s2", program: `page.locator("#p").fill("secret-value")`, succeeded: true });
  await first.flush();

  const raw = await readFile(path, "utf8");
  /*
   * The typed value must not be in the file, and the selector must be: that
   * pairing is the whole distinction between a recipe and a record.
   */
  assert.doesNotMatch(raw, /secret-value/, "the file on disk must not contain the typed value");
  assert.match(raw, /#p/, "but the selector that makes it a recipe must be there");

  const second = new TransitionDb({ path });
  const edges = await second.edgesFrom("example.com", "s1");
  assert.equal(edges.length, 1, "a fresh process must see the learned edge");
  assert.match(edges[0]!.program, /<value>/, "with the placeholder in place of the value");
});

test("a missing or unreadable file is a first run, not a failure", async () => {
  // Losing the learned flows costs a few model calls. Refusing to browse costs
  // the task, so the read must never throw.
  const db = new TransitionDb({ path: "/tmp/definitely-not-here-9f3a/flows.json" });
  assert.deepEqual(await db.edgesFrom("x", "a"), []);
  assert.equal(await db.describe("x"), undefined);
});

test("the flow line describes the site in one sentence", async () => {
  const db = new TransitionDb({ path: await tempPath() });
  assert.equal(await db.describe("x"), undefined, "nothing is claimed about an unseen site");

  await db.record({ host: "x", from: "a", to: "b", program: "p1", succeeded: true });
  await db.record({ host: "x", from: "b", to: "c", program: "p2", succeeded: true });
  const line = await db.describe("x");
  assert.match(line ?? "", /2 recorded steps/);
  assert.match(line ?? "", /a -> b -> c/, "the path is flattened for the model to read");
});

test("clearing a host forgets it, and clearing all forgets everything", async () => {
  // A wrong learned flow whose only remedy is deleting a file by hand is a flow
  // nobody can diagnose.
  const path = await tempPath();
  const db = new TransitionDb({ path });
  await db.record({ host: "a.com", from: "s", to: "t", program: "p", succeeded: true });
  await db.record({ host: "b.com", from: "s", to: "t", program: "p", succeeded: true });

  await db.clear("a.com");
  assert.equal(await db.describe("a.com"), undefined);
  assert.notEqual(await db.describe("b.com"), undefined, "clearing one host leaves the others");

  await db.clear();
  assert.equal(await db.describe("b.com"), undefined);
});
