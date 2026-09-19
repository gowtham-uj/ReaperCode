/**
 * No bare backtick may appear inside a `String.raw` template literal.
 *
 * This has broken the build four times, always the same way: a comment written
 * inside one of these source strings quotes an identifier with backticks, which
 * terminates the template literal early and scatters the rest of the file as
 * syntax errors. The errors point at lines nowhere near the cause, so the time
 * goes into finding it rather than fixing it.
 *
 * The four files that embed source as a string are the ones at risk, and the
 * check is mechanical rather than a review note because a comment is exactly the
 * kind of thing that is read for its meaning and not for its punctuation.
 *
 * An escaped backtick is fine and is what the fix is: inside `String.raw` a
 * backslash survives into the string, and in the emitted JavaScript `\`` is a
 * backtick, so the source reads the same either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const SOURCES = [
  "src/browser/remote-page-source.ts",
  "src/tools/code/worker-source.ts",
  "src/tools/code/bridge.ts",
  "src/tools/code/sandbox-relay.ts",
  "src/tools/code/guard.ts",
];

for (const relative of SOURCES) {
  test(`${relative} has no bare backtick inside its embedded source`, async () => {
    const text = await readFile(new URL(`../../../${relative}`, import.meta.url), "utf8");

    /*
     * The region between the opening `String.raw\`` and the closing backtick,
     * found by the assignment rather than by counting backticks: counting would
     * be measuring the very thing that is wrong.
     */
    const open = /=\s*String\.raw`/.exec(text);
    if (open === null) return;

    const bodyStart = open.index + open[0].length;
    const terminator = text.indexOf("`;", bodyStart);
    assert.ok(terminator !== -1, `${relative}: the template literal is never closed, which is the symptom of this bug`);
    const body = text.slice(bodyStart, terminator);

    /*
     * A backtick that is not preceded by a backslash. `\\\`` and `\`` both pass;
     * a lone one does not. The lookbehind is what distinguishes them, and without
     * it the check would flag every already-correct escape.
     */
    const bare = [...body.matchAll(/(?<!\\)`/g)];
    assert.equal(
      bare.length,
      0,
      `${relative}: ${bare.length} bare backtick(s) inside the raw source string. ` +
        `A comment quoting an identifier is the usual cause. Escape each one as \\\` and the build returns. ` +
        `First at offset ${bare[0]?.index ?? -1}: ${JSON.stringify(body.slice(Math.max(0, (bare[0]?.index ?? 0) - 60), (bare[0]?.index ?? 0) + 60))}`,
    );
  });
}
