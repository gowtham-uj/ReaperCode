/**
 * A failed IndexedDB restore is said out loud on the step that follows it.
 *
 * The notes were written on every attach and read by nothing. The attach
 * reported success whether or not the databases came back, so the only way to
 * learn that a thread had been signed out was to hit the login wall, which the
 * model then spends turns on. The list is the difference between "your session
 * was restored" and "this origin's databases could not be reopened, so expect to
 * be logged out here".
 *
 * Two halves, matching the two ways it can go wrong: the drain itself, which must
 * be read-once and silent when there is nothing to say, and the wiring, which is
 * what was missing. The wiring is checked in the source because the failure was a
 * call nobody made, and a behavioural test of the tool path needs a live browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { ThreadBrowserRuntime } from "../../../../src/browser/thread-runtime.js";

/** The private surface this test reaches into, named so the cast stays honest. */
interface NoteInternals {
  indexedDbRestoreNotes: string[];
}

const internals = (runtime: ThreadBrowserRuntime): NoteInternals => runtime as unknown as NoteInternals;

test("a restore that could not put everything back is reported, once", () => {
  const runtime = new ThreadBrowserRuntime({ threadId: "t-db1", cdpUrl: "ws://127.0.0.1:1/devtools" });
  internals(runtime).indexedDbRestoreNotes = ["https://bank.example: no page was open on this origin, so its databases were not restored"];

  const note = runtime.takeIndexedDbRestoreNote();
  assert.ok(note !== undefined, "a note that exists must be handed to the caller");
  assert.match(note, /bank\.example/, "and it must name the origin, which is what the model acts on");
  assert.match(note, /signed out|logged out/, "and say what it means for the next step");
  assert.equal(runtime.takeIndexedDbRestoreNote(), undefined, "a second read must not repeat it: a sentence on every step stops being read");
});

test("a clean restore says nothing", () => {
  /*
   * The common case. A note printed on every attach would read as noise, and the
   * one attach that mattered would be skipped along with it.
   */
  const runtime = new ThreadBrowserRuntime({ threadId: "t-db2", cdpUrl: "ws://127.0.0.1:1/devtools" });
  assert.equal(runtime.takeIndexedDbRestoreNote(), undefined);
});

const [runtimeSource, toolSource] = await Promise.all([
  readFile(new URL("../../../../src/browser/thread-runtime.ts", import.meta.url), "utf8"),
  readFile(new URL("../../../../src/tools/browser/execute-browser-use.ts", import.meta.url), "utf8"),
]);

test("the note is drained on both paths the model reaches a page through", () => {
  /*
   * `view` and the program path are separate returns, and an attach can be
   * reached through either. One drain site would leave the step that reconnected
   * through a program silent about a database it could not reopen.
   */
  const drains = [...toolSource.matchAll(/takeIndexedDbRestoreNote\(\)/g)];
  assert.equal(drains.length, 2, "both the look path and the program path must drain it");
  assert.match(runtimeSource, /takeIndexedDbRestoreNote\(\): string \| undefined \{/, "and the runtime must be the one that holds the list");
});
