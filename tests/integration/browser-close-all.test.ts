/**
 * "Close every page I own" must terminate, and say why it cannot finish.
 *
 * Measured from a real run: the model closed its pages, watched the count go
 * 13 -> 3 -> 4 -> 8, and concluded the browser was spawning replacements. It was,
 * and for a good reason, but nothing told it so and it spent calls investigating.
 *
 * A thread with no page cannot be asked to do anything, so `resolveActivePage`
 * opens one the moment none exists. Closing the last page therefore *creates* a
 * page, and a program that closes everything it owns can never reach zero: it
 * closes the replacement and gets another.
 *
 * The last close is now refused with the reason, which ends that loop at its first
 * step. This pins both halves: the pages it can close are closed, and the one it
 * cannot is refused in a way the program can read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CDP_URL, probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

const CDP_URL = process.env["REAPER_CDP_URL"] ?? DEFAULT_CDP_URL;
const availability = await probeBrowser(CDP_URL);
const skip = skipUnless(availability);

test("closing every page stops, and the last one is refused with the reason", { skip }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "close-all-"));
  const rt = new ThreadBrowserRuntime({ threadId: "close-all", cdpUrl: CDP_URL, workspaceRoot: workspace });
  try {
    for (let i = 0; i < 3; i++) await rt.newPage(`ca${i}`);

    const result = await executeBrowserUse(
      rt,
      {
        /*
         * The catch is deliberate and is the point: a program that swallows the
         * refusal must still see it, because the answer arrives as a value rather
         * than as a crash. An earlier probe without this catch counted a refused
         * close as a success and hid the fix it was testing.
         */
        code: `const mine = await browser.pages(); const out = []; for (const p of mine) { try { await browser.closePage(p); out.push("closed"); } catch (e) { out.push("refused"); } } return out;`,
        observe: "none",
      } as never,
      { runId: "test", artifactDir: "/tmp", toolCallId: "ca" },
    );

    assert.equal(result.outcome, "SUCCESS", result.output);
    const returned = result.output.slice(result.output.indexOf("RETURNED:"));
    assert.match(returned, /"closed"/, "the pages it can close are closed");
    assert.match(
      returned,
      /"refused"/,
      "and the one it cannot is refused rather than silently replaced, which is what makes the loop terminate",
    );
    assert.doesNotMatch(returned, /"closed","closed","closed","closed"/, "a fourth close must not appear to succeed");

    /* And the thread still works afterwards, which is why one page is kept. */
    const after = await executeBrowserUse(rt, { code: `return "alive";`, observe: "none" } as never, {
      runId: "test", artifactDir: "/tmp", toolCallId: "ca2",
    });
    assert.equal(after.outcome, "SUCCESS", after.output);
  } finally {
    await rt.close().catch(() => undefined);
  }
});
