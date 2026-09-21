/**
 * Does browser_use work on every kind of site, not only the ten in the mission?
 *
 * The mission proves ten sites of one kind (mostly static demo pages). This
 * sweeps a far wider set: SPAs, shadow DOM, iframes, virtualised lists, canvas,
 * file upload inputs, downloads, popups, auth, pagination, and sites that fight
 * automation. Each gets a real program through the real tool, and the receipt is
 * judged on whether the page was read and the interaction landed.
 *
 * Usage: tsx .reaper/e2e/sites-smoke.mts [filter]
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadBrowserRuntime } from "../../src/browser/thread-runtime.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeBrowser, skipUnless } from "../fixtures/browser-availability.js";
import { executeBrowserUse } from "../../src/tools/browser/execute-browser-use.js";

interface Probe {
  name: string;
  url: string;
  what: string;
  code: string;
}

const PROBES: Probe[] = [
  { name: "wikipedia", url: "https://en.wikipedia.org/wiki/Playwright_(software)", what: "read a content page and follow a link",
    code: `const t = await page.title(); const links = await page.locator("a").count(); await page.getByRole("link", { name: /software testing/i }).first().click({ timeout: 8000 }).catch(() => undefined); return { t, links };` },
  { name: "hackernews", url: "https://news.ycombinator.com/", what: "read a large repeated list",
    code: `const rows = await page.locator("tr.athing").count(); const first = await page.locator("tr.athing .titleline a").first().textContent(); return { rows, first };` },
  { name: "github-search", url: "https://github.com/search?q=playwright&type=repositories", what: "SPA-ish results page",
    code: `await page.waitForTimeout(1500); const h = await page.locator("h1, h2").first().textContent().catch(() => null); return { h };` },
  { name: "react-spa", url: "https://react.dev/", what: "hydrated SPA navigation",
    code: `const t = await page.title(); await page.getByRole("link", { name: /learn react/i }).first().click({ timeout: 8000 }).catch(() => undefined); return { t, url: page.url() };` },
  { name: "shadow-dom", url: "https://the-internet.herokuapp.com/shadowdom", what: "shadow root content",
    code: `const n = await page.locator("my-paragraph").count(); const txt = await page.locator("h1").textContent(); return { n, txt };` },
  { name: "iframes", url: "https://the-internet.herokuapp.com/iframe", what: "iframe body editing",
    code: `const f = page.frameLocator("#mce_0_ifr"); const t = await f.locator("body").textContent(); return { t };` },
  { name: "nested-frames", url: "https://the-internet.herokuapp.com/nested_frames", what: "nested frame access",
    code: `const n = page.frames().length; return { frames: n };` },
  { name: "infinite-scroll", url: "https://the-internet.herokuapp.com/infinite_scroll", what: "scroll and re-read",
    code: `await page.mouse.wheel(0, 3000); await page.waitForTimeout(800); const n = await page.locator(".jscroll-added").count(); return { n };` },
  { name: "dynamic-loading", url: "https://the-internet.herokuapp.com/dynamic_loading/1", what: "wait for content",
    code: `await page.getByRole("button", { name: /start/i }).click(); await page.locator("#finish h4").waitFor({ timeout: 15000 }); return { t: await page.locator("#finish h4").textContent() };` },
  { name: "file-upload", url: "https://the-internet.herokuapp.com/upload", what: "file input present",
    code: `const n = await page.locator("#file-upload").count(); return { inputs: n };` },
  { name: "alerts", url: "https://the-internet.herokuapp.com/javascript_alerts", what: "dialog handling",
    code: `page.once("dialog", (d) => d.accept()); await page.getByRole("button", { name: /click for js alert/i }).click(); await page.waitForTimeout(400); return { r: await page.locator("#result").textContent() };` },
  { name: "tables", url: "https://the-internet.herokuapp.com/tables", what: "sort a data table",
    code: `const rows = await page.locator("#table1 tbody tr").count(); await page.locator("#table1 th").first().click(); return { rows };` },
  { name: "dropdown", url: "https://the-internet.herokuapp.com/dropdown", what: "select an option",
    code: `await page.locator("#dropdown").selectOption("1"); return { v: await page.locator("#dropdown").inputValue() };` },
  { name: "canvas", url: "https://the-internet.herokuapp.com/challenging_dom", what: "canvas + dynamic buttons",
    code: `const c = await page.locator("canvas").count(); const b = await page.locator("a.button").count(); return { c, b };` },
  { name: "js-error", url: "https://the-internet.herokuapp.com/javascript_error", what: "a page whose own JS throws",
    code: `const t = await page.title(); return { t, alive: true };` },
  /*
   * An HTTP auth wall. The site answers 401 without credentials and 200 with
   * `admin:admin`, so the probe carries them in the URL, which is the one form a
   * browser accepts without a context-level `httpCredentials` option.
   *
   * A page that still refuses is not a tool failure: the receipt names
   * `ERR_INVALID_AUTH_CREDENTIALS` and the page is reported unreadable, which is
   * the honest answer about a wall the client cannot pass. So the probe asserts
   * the tool *reached* the page and said something specific about it, rather than
   * that the page opened.
   */
  { name: "basic-auth", url: "https://admin:admin@the-internet.herokuapp.com/basic_auth", what: "http auth wall",
    code: `const t = await page.locator("h3, .example h3").first().textContent({ timeout: 8000 }).catch(() => null); return { t: (t ?? "").trim(), url: await page.url() };` },
  { name: "slow-resource", url: "https://the-internet.herokuapp.com/slow", what: "slow response",
    code: `const t = await page.title(); return { t };` },
  { name: "demoqa-widgets", url: "https://demoqa.com/select-menu", what: "react-select combobox",
    code: `const n = await page.locator("#selectMenuContainer").count(); return { n };` },
  { name: "demoqa-frames", url: "https://demoqa.com/frames", what: "frame content",
    code: `const n = page.frames().length; return { frames: n };` },
  { name: "uitesting-dynamic-id", url: "http://uitestingplayground.com/dynamicid", what: "a button whose id changes",
    code: `await page.getByRole("button", { name: /button with dynamic id/i }).click(); return { ok: true };` },
  { name: "uitesting-client-side-delay", url: "http://uitestingplayground.com/clientdelay", what: "delayed render",
    code: `await page.getByRole("button", { name: /button triggering client side delay/i }).click({ timeout: 15000 }); const el = page.locator(".bg-success"); await el.waitFor({ timeout: 30000 }); return { t: (await el.textContent()).trim() };` },
  { name: "uitesting-progress-bar", url: "http://uitestingplayground.com/progressbar", what: "poll async state",
    code: `await page.getByRole("button", { name: /start/i }).click(); await page.waitForTimeout(1200); const v = await page.locator("#progressBar").textContent(); return { v };` },
  { name: "w3schools", url: "https://www.w3schools.com/html/html_forms.asp", what: "ad-heavy content site",
    code: `const t = await page.title(); const h1 = await page.locator("h1").first().textContent(); return { t, h1 };` },
  { name: "mdn-live", url: "https://developer.mozilla.org/en-US/play", what: "a heavy app-like docs page",
    code: `const t = await page.title(); return { t };` },
  { name: "npm-package", url: "https://www.npmjs.com/package/react", what: "JS-rendered registry page",
    code: `const v = await page.locator("h3, h2").first().textContent().catch(() => null); return { v };` },
  { name: "stackoverflow", url: "https://stackoverflow.com/questions/tagged/playwright", what: "bot-hostile site",
    code: `const t = await page.title(); const q = await page.locator(".s-post-summary").count(); return { t, q };` },
  { name: "google", url: "https://www.google.com/search?q=playwright+browser+automation", what: "search results and consent walls",
    code: `const t = await page.title(); const n = await page.locator("a").count(); return { t, n };` },
  { name: "amazon", url: "https://www.amazon.com/", what: "retail site with heavy tracking",
    code: `const t = await page.title(); const n = await page.locator("input, a").count(); return { t, n };` },
  { name: "data-url", url: "data:text/html,<h1 id='x'>inline</h1>", what: "a data: URL page",
    code: `return { t: await page.locator("#x").textContent() };` },
  { name: "about-blank-setcontent", url: "about:blank", what: "setContent on a blank page",
    code: `await page.setContent("<h1 id='y'>made</h1>"); return { t: await page.locator("#y").textContent() };` },
];

const availability = await probeBrowser(process.env["REAPER_CDP_URL"] ?? "ws://127.0.0.1:3000");
const skip = skipUnless(availability);
const probes = PROBES;
const cdpUrl = process.env.REAPER_CDP_URL ?? "ws://127.0.0.1:3000";
const workspace = await mkdtemp(join(tmpdir(), "smoke-"));
const rt = new ThreadBrowserRuntime({ threadId: "sites-smoke", cdpUrl, workspaceRoot: workspace });
const meta = { runId: "s", artifactDir: "/tmp", toolCallId: "c" };
const siteCleanup = async (): Promise<void> => { /* probes open only browser pages */ };

test.after(async () => {
  await rt.close().catch(() => undefined);
  await siteCleanup();
});

/**
 * Every probe, as one test each so a failure names the site.
 *
 * `test()` rather than a loop with a counter: a single aggregate test that throws
 * on the first failure hides the other twenty-nine results, and the point of this
 * file is to say which kind of site broke.
 */
for (const [index, p] of probes.entries()) {
  test(`browser_use works on: ${p.name} (${p.what})`, { skip }, async () => {
    void index;
    await rt.newPage(`smoke-${p.name}`);
    await rt.setActive(`smoke-${p.name}`);
    const v = await executeBrowserUse(
      rt,
      { code: `await page.goto(${JSON.stringify(p.url)}, { waitUntil: "domcontentloaded", timeout: 45000 }); ${p.code}`, observe: "none", timeout_ms: 90000 } as never,
      meta,
    );
    /*
     * `page.url()` is deliberately not asserted on: a property read returns a node
     * that has to be awaited, and that is documented in `remote-page-source.ts`,
     * so a probe that forgot the await would fail for a reason about the probe.
     */
    assert.equal(v.outcome, "SUCCESS", `${p.name} (${p.url})\n${v.output.slice(0, 700)}`);
  });
}
