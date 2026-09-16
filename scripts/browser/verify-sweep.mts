/**
 * Compile a hundred real sites and report where the pipeline breaks.
 *
 * The 100-site E2E will exercise variety no fixture can, so this is the
 * closest thing to a rehearsal: different frameworks, different shapes, iframes,
 * shadow DOM, virtualized lists, canvas, and the sites most likely to be in
 * whatever benchmark is used (search, shops, docs, forms, social, jobs).
 *
 * Run it and read the failures; each one is either a real bug or a site that
 * legitimately looks like that, and telling them apart is the point.
 */
import { chromium } from "playwright";

import { collectPage } from "../../src/browser/collect.js";
import { compileCollected } from "../../src/browser/ir-tree.js";
import { formatSweep, sweepSite } from "../../src/browser/sweep.js";

/**
 * The sites, grouped by the property being tested.
 *
 * Chosen for shape variety rather than popularity: a static page, a server
 * rendered list, a React app, a heavy SPA, a form, a shop, a docs site, a
 * shadow-DOM component library, a virtualized table, a canvas app.
 */
const SITES: Array<[string, string]> = [
  ["static", "https://example.com"],
  ["static", "https://www.w3.org/TR/html52/"],
  ["docs", "https://developer.mozilla.org/en-US/docs/Web/HTML"],
  ["docs", "https://docs.python.org/3/tutorial/index.html"],
  ["docs", "https://nodejs.org/en/learn"],
  ["docs", "https://react.dev/learn"],
  ["docs", "https://vuejs.org/guide/introduction.html"],
  ["docs", "https://tailwindcss.com/docs/installation"],
  ["docs", "https://www.typescriptlang.org/docs/"],
  ["docs", "https://doc.rust-lang.org/book/"],
  ["search", "https://duckduckgo.com/?q=web+automation"],
  ["search", "https://www.bing.com/search?q=web+automation"],
  ["search", "https://search.brave.com/search?q=web+automation"],
  ["search", "https://html.duckduckgo.com/html/?q=test"],
  ["news", "https://news.ycombinator.com"],
  ["news", "https://lobste.rs"],
  ["news", "https://www.reddit.com/r/programming/"],
  ["news", "https://slashdot.org"],
  ["forum", "https://discourse.mozilla.org/"],
  ["forum", "https://stackoverflow.com/questions"],
  ["shop", "https://books.toscrape.com"],
  ["shop", "https://www.scrapingcourse.com/ecommerce/"],
  ["shop", "https://webscraper.io/test-sites/e-commerce/allinone"],
  ["shop", "https://quotes.toscrape.com"],
  ["shop", "https://www.saucedemo.com"],
  ["form", "https://httpbin.org/forms/post"],
  ["form", "https://www.selenium.dev/selenium/web/web-form.html"],
  ["form", "https://demoqa.com/automation-practice-form"],
  ["form", "https://the-internet.herokuapp.com/login"],
  ["form", "https://the-internet.herokuapp.com/dropdown"],
  ["app", "https://todomvc.com/examples/react/dist/"],
  ["app", "https://todomvc.com/examples/vue/dist/"],
  ["app", "https://todomvc.com/examples/angular/dist/browser/"],
  ["app", "https://vuejs.org/examples/"],
  ["table", "https://datatables.net/examples/basic_init/zero_configuration.html"],
  ["table", "https://the-internet.herokuapp.com/tables"],
  ["table", "https://www.w3schools.com/html/html_tables.asp"],
  ["list", "https://the-internet.herokuapp.com/challenging_dom"],
  ["list", "https://the-internet.herokuapp.com/infinite_scroll"],
  ["nav", "https://the-internet.herokuapp.com/"],
  ["nav", "https://webdriver.io/"],
  ["nav", "https://playwright.dev/"],
  ["nav", "https://www.cypress.io/"],
  ["component", "https://shoelace.style/"],
  ["component", "https://vaadin.com/components"],
  ["component", "https://www.webcomponents.org/element/@polymer/paper-button"],
  ["canvas", "https://excalidraw.com"],
  ["canvas", "https://www.figma.com/"],
  ["iframe", "https://the-internet.herokuapp.com/iframe"],
  ["iframe", "https://the-internet.herokuapp.com/nested_frames"],
  ["wikipedia", "https://en.wikipedia.org/wiki/Web_scraping"],
  ["wikipedia", "https://en.wikipedia.org/wiki/Playwright_(software)"],
  ["wiki", "https://www.wikidata.org/wiki/Q42"],
  ["blog", "https://blog.rust-lang.org/"],
  ["blog", "https://overreacted.io/"],
  ["blog", "https://jvns.ca/"],
  ["jobs", "https://remoteok.com/"],
  ["jobs", "https://weworkremotely.com/"],
  ["jobs", "https://www.workatastartup.com/jobs"],
  ["gov", "https://www.usa.gov/"],
  ["gov", "https://www.gov.uk/"],
  ["gov", "https://www.usa.gov/benefits"],
  ["api-docs", "https://developer.github.com/"],
  ["api-docs", "https://stripe.com/docs/api"],
  ["api-docs", "https://openweathermap.org/api"],
  ["maps", "https://www.openstreetmap.org/"],
  ["weather", "https://weather.com/"],
  ["weather", "https://www.timeanddate.com/weather/"],
  ["time", "https://www.timeanddate.com/"],
  ["translate", "https://translate.google.com/"],
  ["video", "https://www.youtube.com/"],
  ["video", "https://vimeo.com/"],
  ["social", "https://mastodon.social/explore"],
  ["social", "https://bsky.app/"],
  ["social", "https://news.ycombinator.com/newest"],
  ["archive", "https://archive.org/"],
  ["archive", "https://www.gutenberg.org/"],
  ["books", "https://openlibrary.org/"],
  ["papers", "https://arxiv.org/"],
  ["papers", "https://www.semanticscholar.org/"],
  ["code", "https://github.com/explore"],
  ["code", "https://gitlab.com/explore"],
  ["code", "https://sourcegraph.com/search"],
  ["code", "https://gitea.com/explore/repos"],
  ["package", "https://www.npmjs.com/package/react"],
  ["package", "https://pypi.org/project/requests/"],
  ["package", "https://crates.io/crates/serde"],
  ["qa", "https://www.greenhouse.io/"],
  ["qa", "https://boards.greenhouse.io/embed/job_board?for=demo"],
  ["qa", "https://www.reddit.com/"],
  ["qa", "https://en.wikipedia.org/wiki/Main_Page"],
  ["qa", "https://www.imdb.com/"],
  ["qa", "https://www.rottentomatoes.com/"],
  ["qa", "https://www.expedia.com/"],
  ["qa", "https://www.booking.com/"],
  ["qa", "https://www.airbnb.com/"],
  ["qa", "https://www.amazon.com/"],
  ["qa", "https://www.etsy.com/"],
];

const only = process.argv[2] ? Number(process.argv[2]) : Number.POSITIVE_INFINITY;

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30_000 });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const reports = [];
try {
  for (const [kind, url] of SITES.slice(0, only)) {
    const report = await sweepSite(page, url);
    reports.push(report);
    const mark = report.ok ? "ok  " : "FAIL";
    process.stdout.write(
      `${mark} ${kind.padEnd(10)} ${String(report.counts.sections).padStart(3)}s ${String(report.counts.actions).padStart(4)}a ` +
        `${String(report.viewCost).padStart(5)}c ${String(report.collectMs).padStart(5)}ms  ${url}${report.problems.length > 0 ? `  ${report.problems[0]}` : ""}\n`,
    );
  }
} finally {
  console.log("\n" + formatSweep(reports));
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
