/**
 * Read a real page with the multi-source collector and print what it found.
 *
 * Manual verification rather than a unit test, because its value is in showing
 * the actual result on a real page: the counts, the elements the narrow detector
 * missed, and what the coverage looks like. Run it and judge.
 */
import { chromium } from "playwright";

import { collectPage } from "../../src/browser/collect.js";
import { signalNames } from "../../src/browser/signals.js";

const url = process.argv[2] ?? "about:blank";
const hard = process.argv.includes("--hard");

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222", { timeout: 30_000 });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

try {
  if (hard) {
    // Every shape the narrow detector misses, in one page.
    await page.setContent(`<!doctype html><body>
<div id="app">
  <h1>Application</h1>
  <div id="divbtn" role="button" tabindex="0" style="cursor:pointer" onclick="void 0">Continue</div>
  <div id="bare">Bare clickable</div>
  <button id="native">Native button</button>
  <a id="link" href="/apply">Apply now</a>
  <input id="email" value="typed@example.com">
  <label id="lbl" for="email">Email</label>
  <p id="text">Some ordinary text</p>
  <my-select id="host"></my-select>
  <svg width="200" height="60"><g><rect width="200" height="60" fill="#eee"/><text id="svgtext" x="10" y="30">September</text><path id="svgpath" d="M0 0 L10 10" style="cursor:pointer"/></g></svg>
  <canvas id="cv" width="300" height="150"></canvas>
  <iframe id="frame" srcdoc="<button id='in-frame'>Inside the frame</button><input id='fin' value='frame value'>"></iframe>
  <div id="scroller" style="height:120px;overflow-y:auto;width:300px">
    ${Array.from({ length: 60 }, (_, i) => `<div>row ${i}</div>`).join("")}
  </div>
</div>
<script>
  document.getElementById("bare").addEventListener("click", () => {});
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = '<button id="shadow-btn">Shadow button</button><input id="shadow-input" value="shadow value">';
  const c = document.getElementById("cv").getContext("2d");
  c.fillStyle = "#36c"; c.fillRect(10, 10, 100, 40);
  c.fillStyle = "#fff"; c.fillText("Submit", 30, 35);
</script>
</body></html>`);
    await page.waitForTimeout(500);
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(300);
  }

  const started = Date.now();
  const collected = await collectPage(page);
  const elapsed = Date.now() - started;

  console.log(`\ncollect ${elapsed}ms`);
  console.log(
    `raw nodes ${collected.counts.rawNodes} | AX nodes ${collected.counts.axNodes} | ` +
      `interactive candidates ${collected.counts.candidates} | visible ${collected.counts.visible} | ` +
      `listener-probed ${collected.counts.listenerProbed}`,
  );

  console.log(`\nframes (${collected.frames.length}):`);
  for (const frame of collected.frames) {
    console.log(`  ${(frame.prefix || "main").padEnd(5)} ${frame.read ? "read" : "UNREAD"} ${frame.elementCount} elements  ${frame.url.slice(0, 50)}${frame.unreadReason ? ` (${frame.unreadReason})` : ""}`);
  }

  console.log(`\nelements (${collected.elements.length}):`);
  for (const element of collected.elements) {
    const id = element.testId ?? element.id ?? "";
    const value = element.value ? ` = ${JSON.stringify(element.value.slice(0, 24))}` : "";
    const conflict = element.valueConflicts ? " VALUE-CONFLICT" : "";
    const shadow = element.inShadow ? " [shadow]" : "";
    console.log(
      `  ${(element.frameId || "main").padEnd(5)} ${element.tag.padEnd(9)} ${element.role.padEnd(11)} ` +
        `${element.accessibleName.slice(0, 26).padEnd(26)} conf=${element.interaction.confidence.toFixed(2)} ` +
        `[${signalNames(element.interaction).join(",")}]${id ? ` #${id}` : ""}${value}${conflict}${shadow}`,
    );
  }

  if (collected.canvases.length > 0) console.log(`\ncanvas regions: ${collected.canvases.length}`);
  if (collected.scrollRegions.length > 0) {
    console.log(`\nscroll regions:`);
    for (const region of collected.scrollRegions) {
      console.log(`  overflow x${region.overflowRatio} children=${region.observedChildren} sweepSafe=${region.sweepSafe}${region.unsafeReason ? ` (${region.unsafeReason})` : ""}`);
    }
  }
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
