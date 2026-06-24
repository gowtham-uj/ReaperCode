import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";

import { ToolExecutor } from "../../src/tools/executor.js";
import { createTempWorkspace } from "../fixtures/workspace.js";

interface BrowserToolOutput {
  text: string;
  snapshot: string;
  screenshotPath?: string;
  interactive: Array<{
    ref: string;
    text?: string;
    selectorHint?: string;
  }>;
}

async function createExecutor(workspaceRoot: string) {
  return new ToolExecutor({
    workspaceRoot,
    runId: "browser-run-1",
    sessionId: "session-1",
    traceId: "trace-1",
    logLevel: "info",
    safetyProfile: "allow_all",
  });
}

let browserAvailability: Promise<string | null> | null = null;

function checkBrowserAvailability(): Promise<string | null> {
  browserAvailability ??= (async () => {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      await browser.close();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "unknown browser launch failure";
    }
  })();
  return browserAvailability;
}

async function skipIfBrowserUnavailable(t: TestContext): Promise<boolean> {
  const reason = await checkBrowserAvailability();
  if (!reason) return false;
  t.skip(`Playwright Chromium unavailable: ${reason}`);
  return true;
}

test("browser_control navigates, types, clicks, and captures a screenshot", async (t) => {
  if (await skipIfBrowserUnavailable(t)) return;
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  try {
    const html = `
      <html>
        <body>
          <label>Name <input id="name" /></label>
          <button id="go" onclick="document.querySelector('#out').textContent = 'Hello ' + document.querySelector('#name').value">Go</button>
          <p id="out">Ready</p>
        </body>
      </html>
    `;

    const navigate = await executor.execute({
      id: "browser-nav",
      name: "browser_control",
      args: { action: "navigate", url: `data:text/html,${encodeURIComponent(html)}`, screenshot: true, maxInteractive: 10 },
    });
    assert.equal(navigate.ok, true);
    const navigateOutput = navigate.output as BrowserToolOutput;
    assert.match(String(navigateOutput.text), /Ready/);
    assert.match(navigateOutput.snapshot, /\[ref=e\d+\]/);
    const screenshotPath = navigateOutput.screenshotPath;
    assert.ok(screenshotPath);
    assert.ok((await stat(screenshotPath)).size > 0);
    const inputRef = navigateOutput.interactive.find((element) => element.selectorHint === "#name")?.ref;
    const buttonRef = navigateOutput.interactive.find((element) => element.selectorHint === "#go")?.ref;
    assert.ok(inputRef);
    assert.ok(buttonRef);

    const type = await executor.execute({
      id: "browser-type",
      name: "browser_control",
      args: { action: "type", ref: inputRef, text: "Ada", humanize: true },
    });
    assert.equal(type.ok, true);

    const click = await executor.execute({
      id: "browser-click",
      name: "browser_control",
      args: { action: "click", ref: buttonRef, humanize: true },
    });
    assert.equal(click.ok, true);
    assert.match(String((click.output as BrowserToolOutput).text), /Hello Ada/);
  } finally {
    await executor.cleanupBackgroundProcesses("test_cleanup");
  }
});

test("computer_control can click by viewport coordinate", async (t) => {
  if (await skipIfBrowserUnavailable(t)) return;
  const workspaceRoot = await createTempWorkspace();
  const executor = await createExecutor(workspaceRoot);

  try {
    const html = `
      <html>
        <body>
          <button style="position:absolute;left:20px;top:20px;width:120px;height:60px" onclick="document.querySelector('#out').textContent = 'coordinate clicked'">Hit</button>
          <p id="out"></p>
        </body>
      </html>
    `;

    await executor.execute({
      id: "browser-nav",
      name: "browser_control",
      args: { action: "navigate", url: `data:text/html,${encodeURIComponent(html)}`, width: 400, height: 300 },
    });

    const click = await executor.execute({
      id: "computer-click",
      name: "computer_control",
      args: { action: "click", x: 80, y: 50, humanize: true },
    });

    assert.equal(click.ok, true);
    assert.match(String((click.output as { text: string }).text), /coordinate clicked/);
  } finally {
    await executor.cleanupBackgroundProcesses("test_cleanup");
  }
});
