/**
 * Drives the real web UI in a real browser, as a user would: type, watch,
 * type again mid-turn, answer an approval.
 *
 * Runs its own app-server with a scripted `turnRunner` so the flow is
 * deterministic and needs no model credentials — the browser, the Vite bundle,
 * the BFF, the WebSocket, and the projection are all real.
 *
 * Usage: npx tsx tests/e2e-ui-smoke.mts
 * Writes screenshots to /tmp/ui-smoke/.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type ConsoleMessage, type Page } from "playwright";
import { createServer as createViteServer } from "vite";

import type { ManagedTurnRunner } from "../src/app-server/managed-turn-runner.js";
import { startAppServer } from "../src/app-server/server.js";
import type { RuntimeEngineResult } from "../src/runtime/engine.js";
import { startBff } from "../web/bff/src/server.js";

const SHOTS = "/tmp/ui-smoke";
const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    process.stdout.write(`  PASS  ${description}\n`);
  } else {
    failures.push(description);
    process.stdout.write(`  FAIL  ${description}\n`);
  }
}

function engineResult(message: string): RuntimeEngineResult {
  return { assistantMessage: message, toolResults: [], events: [], trajectoryPath: "", state: {} as RuntimeEngineResult["state"] };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until a condition holds, so the script waits on the UI rather than on a clock. */
async function until(predicate: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(150);
  }
  process.stdout.write(`  (timed out waiting for ${label})\n`);
  return false;
}

const ts = (): string => new Date().toISOString();

/** Lets the harness step the scripted turn forward from the outside. */
interface Gate { wait: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

const toolCallGate = gate();
const approvalTurnSeen = gate();
let steeredMessages: string[] = [];

/**
 * Turn 1: a slow tool call, then a model-loop boundary that drains steering.
 * Turn 2: a blocking approval.
 */
let turnIndex = 0;
const runner: ManagedTurnRunner = async (input) => {
  turnIndex += 1;
  await input.eventSink({ type: "turn.started", runId: input.turnId, sessionId: input.threadId, timestamp: ts() });

  if (turnIndex === 1) {
    await input.eventSink({ type: "assistant.message.delta", text: "Reading the auth module", timestamp: ts() });
    await input.eventSink({ type: "assistant.message.completed", text: "Reading the auth module", timestamp: ts() });
    const toolCall = {
      id: "read-1",
      name: "view_file" as const,
      args: { path: "auth.ts", startLine: 1, endLine: 40 },
    };
    await input.eventSink({ type: "tool.started", toolCall, timestamp: ts() });
    // The user types during this window. Nothing drains until the boundary.
    toolCallGate.open();
    await sleep(4_000);
    await input.eventSink({
      type: "tool.completed",
      toolCall,
      result: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        ok: true,
        durationMs: 4_000,
        output: "export function auth(): void {}",
      },
      timestamp: ts(),
    });

    // Model-loop boundary — mirrors engine.ts:1298.
    steeredMessages = input.turnControl.drain();

    const reply = steeredMessages.length > 0
      ? `Got your follow-up: ${steeredMessages.join(" | ")}`
      : "Nothing was steered in.";
    await input.eventSink({ type: "assistant.message.completed", text: reply, timestamp: ts() });
    await input.eventSink({ type: "turn.completed", runId: input.turnId, sessionId: input.threadId, assistantMessage: reply, timestamp: ts() });
    return engineResult(reply);
  }

  approvalTurnSeen.open();
  const decision = await input.approvalRequester.requestApproval({
    approvalId: `ui-smoke-approval-${turnIndex}`,
    runId: input.turnId,
    sessionId: input.threadId,
    toolCall: { id: "bash-1", name: "bash", args: { cmd: "rm -rf build" } },
    workspaceRoot: input.workspaceRoot,
    workingDirectory: input.workspaceRoot,
    permissionMode: "strict",
    reason: "This deletes the build directory.",
  }, input.abortSignal);

  const reply = `You chose: ${decision}`;
  await input.eventSink({ type: "assistant.message.completed", text: reply, timestamp: ts() });
  await input.eventSink({ type: "turn.completed", runId: input.turnId, sessionId: input.threadId, assistantMessage: reply, timestamp: ts() });
  return engineResult(reply);
};

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

/** What the user can actually read on screen, for the report. */
async function visibleTranscript(page: Page): Promise<string> {
  return (await page.locator(".transcript").innerText()).trim();
}

async function main(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  const workspace = await mkdtemp(path.join(tmpdir(), "ui-smoke-"));
  await writeFile(path.join(workspace, "auth.ts"), "export function auth(): void {}\n");

  const appServer = await startAppServer({
    workspaceRoot: workspace,
    listen: "ws://127.0.0.1:0",
    turnRunner: runner,
    approvalTimeoutMs: 120_000,
  });
  const bff = await startBff({ appServerUrl: appServer.ready.url, host: "127.0.0.1", port: 0, workspaceRoot: workspace });

  // A dedicated Vite server pointed at this harness's BFF, so the smoke test
  // never depends on whatever is already running on 4180.
  process.env.REAPER_BFF_URL = bff.url;
  // A fixed port distinct from the dev server's 5273, so running this smoke
  // test never collides with a dev server the user already has open.
  const uiPort = Number(process.env.UI_SMOKE_PORT ?? 5274);
  const vite = await createViteServer({
    configFile: path.join(process.cwd(), "web/ui/vite.config.ts"),
    server: {
      host: "127.0.0.1",
      port: uiPort,
      strictPort: true,
      proxy: { "/ws": { target: bff.url, ws: true }, "/api": { target: bff.url } },
    },
  });
  await vite.listen();
  const uiUrl = `http://127.0.0.1:${uiPort}/`;
  process.stdout.write(`UI at ${uiUrl}\n\n`);

  // `chromium.launch()` prefers the headless-shell build; ask for the full
  // browser so only one download is needed.
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const consoleErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  try {
    process.stdout.write("1. First paint\n");
    await page.goto(uiUrl, { waitUntil: "domcontentloaded" });
    const connected = await until(
      async () => (await page.locator(".status-label").first().innerText()) === "connected",
      "the connection to come up",
    );
    check(connected, "the UI connects to the agent on load");
    check(
      (await visibleTranscript(page)).includes("Ask the agent to do something"),
      "an empty transcript tells the user what to do",
    );
    await shot(page, "01-first-paint");

    process.stdout.write("\n2. Sending the first message\n");
    const composer = page.locator(".composer textarea");
    await composer.fill("Look at how auth works");
    check(
      (await page.locator(".composer button").innerText()).trim() === "Send",
      "the button reads 'Send' when the agent is idle",
    );
    await composer.press("Enter");

    check(
      await until(async () => (await visibleTranscript(page)).includes("Look at how auth works"), "the user's message"),
      "the user's own message appears in the transcript immediately",
    );
    check(
      await until(async () => (await visibleTranscript(page)).includes("Reading the auth module"), "the agent's reply"),
      "the agent's streamed reply renders",
    );

    process.stdout.write("\n3. Typing during a tool call\n");
    await toolCallGate.wait;
    check(
      await until(async () => (await page.locator(".composer button").innerText()).trim() === "Queue", "the Queue label"),
      "the button switches to 'Queue' while the agent is working",
    );
    check(await composer.isEnabled(), "the composer stays enabled during a turn — typing is not blocked");
    check(
      (await composer.getAttribute("placeholder"))?.includes("after the current step") ?? false,
      "the placeholder explains that a message will be queued",
    );
    await shot(page, "02-mid-turn");

    await composer.fill("Also check the session module");
    await composer.press("Enter");
    check(
      await until(async () => (await page.locator(".queued-message").count()) === 1, "the queued card"),
      "a message typed mid-turn shows as queued rather than vanishing",
    );
    check(
      (await page.locator(".queued-meta").innerText()).includes("sends after the current step"),
      "the queued message says when it will be sent",
    );
    check(await composer.inputValue() === "", "the composer clears after queueing");
    await shot(page, "03-queued");

    // A second queued message — the queue must hold more than one, in order.
    await composer.fill("And the token refresh path");
    await composer.press("Enter");
    check(
      await until(async () => (await page.locator(".queued-message").count()) === 2, "two queued cards"),
      "more than one message can be queued",
    );
    const queuedTexts = await page.locator(".queued-body").allInnerTexts();
    check(
      queuedTexts[0]?.includes("Also check the session module") === true
      && queuedTexts[1]?.includes("And the token refresh path") === true,
      "queued messages stay in the order they were typed",
    );

    process.stdout.write("\n4. The queue drains at the model-loop boundary\n");
    check(
      await until(async () => (await page.locator(".queued-message").count()) === 0, "the queue to drain", 30_000),
      "queued messages leave the queue once the agent takes them",
    );
    const afterDrain = await visibleTranscript(page);
    check(
      afterDrain.includes("Also check the session module") && afterDrain.includes("And the token refresh path"),
      "queued messages become real transcript messages, not lost text",
    );
    check(
      steeredMessages.includes("Also check the session module"),
      "the queued message actually reached the agent's next model request",
    );
    check(
      afterDrain.includes("Got your follow-up"),
      "the agent's reply shows it saw the queued message",
    );
    check(
      afterDrain.indexOf("Look at how auth works") < afterDrain.indexOf("Also check the session module"),
      "the transcript keeps the conversation in order",
    );
    await shot(page, "04-drained");

    process.stdout.write("\n5. Cancelling a queued message\n");
    check(
      await until(async () => (await page.locator(".composer button").innerText()).trim() === "Send", "idle state"),
      "the button returns to 'Send' when the turn ends",
    );

    process.stdout.write("\n6. Approvals\n");
    await composer.fill("Clean the build directory");
    await composer.press("Enter");
    await approvalTurnSeen.wait;
    check(
      await until(async () => (await page.locator(".approval").count()) === 1, "the approval card"),
      "a blocking approval renders inline in the transcript",
    );
    const approvalText = await page.locator(".approval").innerText();
    check(approvalText.includes("rm -rf build"), "the approval shows the exact command being approved");
    check(
      approvalText.includes("This deletes the build directory"),
      "the approval shows the agent's stated reason",
    );
    const buttons = await page.locator(".approval-actions button").allInnerTexts();
    check(buttons.length > 0, "the approval offers decisions");
    check(buttons.some((b) => /approve/i.test(b)) && buttons.some((b) => /deny/i.test(b)),
      "the approval offers both approve and deny");
    await shot(page, "05-approval");

    // Keyboard reachability: the decision must be answerable without a mouse.
    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return false;
      return getComputedStyle(active).outlineStyle !== "none" || active.matches(":focus-visible");
    });
    check(focusVisible, "keyboard focus is visible");

    await page.locator(".approval-actions button").first().click();
    check(
      await until(async () => (await visibleTranscript(page)).includes("You chose:"), "the decision to reach the agent"),
      "answering the approval unblocks the agent",
    );
    check(
      await until(async () => (await page.locator(".approval").count()) === 0, "the card to clear"),
      "the approval card clears once answered",
    );
    await shot(page, "06-after-approval");

    process.stdout.write("\n7. Edge cases\n");
    check(
      await composer.isEnabled() && (await page.locator(".composer button").isDisabled()),
      "an empty composer disables Send but leaves the field usable",
    );

    // Whitespace-only input must not create an empty message.
    await composer.fill("   ");
    check(await page.locator(".composer button").isDisabled(), "whitespace-only input cannot be sent");
    await composer.fill("");

    // Shift+Enter is a newline, not a send.
    const before = await page.locator(".user-message").count();
    await composer.fill("line one");
    await composer.press("Shift+Enter");
    await composer.type("line two");
    check((await composer.inputValue()).includes("\n"), "Shift+Enter inserts a newline instead of sending");
    check(await page.locator(".user-message").count() === before, "Shift+Enter did not send the message");
    await composer.fill("");

    process.stdout.write("\n8. Narrow viewport\n");
    await page.setViewportSize({ width: 720, height: 900 });
    await sleep(400);
    const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check(!overflows, "the layout does not overflow horizontally at 720px");
    await shot(page, "07-narrow");
    await page.setViewportSize({ width: 1400, height: 900 });

    process.stdout.write("\n9. Console health\n");
    check(consoleErrors.length === 0, `no console errors (saw ${consoleErrors.length})`);
    for (const error of consoleErrors.slice(0, 5)) process.stdout.write(`      ${error}\n`);

    process.stdout.write("\n--- What the user sees ---\n");
    process.stdout.write(`${await visibleTranscript(page)}\n`);
  } finally {
    await browser.close();
    await vite.close();
    await bff.close();
    await appServer.stop();
  }

  process.stdout.write(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} FAILED:`}\n`);
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
  process.stdout.write(`Screenshots in ${SHOTS}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
