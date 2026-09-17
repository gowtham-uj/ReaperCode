/**
 * The untrusted-events note, and the false positive that made it useless.
 *
 * Read from a live mission: the note fired on most steps, because the check was
 * "the program contains the word evaluate and the substring .click(" . Almost
 * every real program reads something with `evaluate` and then clicks with the
 * real API, so the model was told its trusted click was untrusted on step after
 * step, and learned to skip the note. The one step where it mattered had lost its
 * meaning by then.
 *
 * The question the note exists to answer is narrower: did page script dispatch
 * the event? Inside `evaluate` there is no Playwright input API, so a click there
 * is necessarily a DOM event; a click outside it is trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchesEventFromScript } from "../../../src/tools/browser/execute-browser-use.js";

test("a real click after an evaluate read is not flagged", () => {
  // The exact shape that produced the false positive on the mission.
  const code = `
    const before = await page.evaluate("document.title");
    await page.locator("#submit").click();
    return before;
  `;
  assert.equal(dispatchesEventFromScript(code), false);
});

test("a click dispatched inside evaluate is flagged", () => {
  assert.equal(dispatchesEventFromScript(`await page.evaluate("document.querySelector('#go').click()")`), true);
  assert.equal(dispatchesEventFromScript(`await page.evaluate(() => document.getElementById('go').click())`), true);
  assert.equal(dispatchesEventFromScript(`await page.evaluate(() => { document.forms[0].submit(); })`), true);
  assert.equal(
    dispatchesEventFromScript(`await page.evaluate("document.dispatchEvent(new MouseEvent('click'))")`),
    true,
  );
});

test("a read-only evaluate with no dispatch is not flagged", () => {
  assert.equal(dispatchesEventFromScript(`await page.evaluate("document.querySelectorAll('a').length")`), false);
  assert.equal(dispatchesEventFromScript(`await page.evaluate(() => document.body.innerText)`), false);
});

test("a locator click is not swallowed into a preceding evaluate argument", () => {
  // The scan must stop at the end of the evaluate argument. A naive "does the
  // program contain evaluate and .click(" check failed exactly here.
  const code = `
    const n = await page.evaluate("document.images.length");
    await page.getByRole("button", { name: "Continue" }).click();
    return n;
  `;
  assert.equal(dispatchesEventFromScript(code), false);
});

test("multiple evaluates are each checked on their own", () => {
  const code = `
    await page.evaluate("document.body.scrollTop = 0");
    await page.evaluate("document.querySelector('.ok').click()");
  `;
  assert.equal(dispatchesEventFromScript(code), true);
});

test("a comma inside the evaluate argument does not end the scan early", () => {
  // `fn(a, b)` as the argument: the scan must survive the inner comma and still
  // see the click after it.
  const code = `await page.evaluate(() => { const f = (a, b) => a + b; document.querySelector('#x').click(); })`;
  assert.equal(dispatchesEventFromScript(code), true);
});

test("a comma inside a nested string does not end the scan early", () => {
  const code = `await page.evaluate("const s = 'a,b'; document.querySelector('#x').click()")`;
  assert.equal(dispatchesEventFromScript(code), true);
});
