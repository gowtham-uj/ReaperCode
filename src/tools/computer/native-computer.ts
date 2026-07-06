import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

import type { ToolRuntimeMetadata } from "../browser/computer-browser.js";
import { getComputerTunables } from "../../config/config-tunables.js";


export const NATIVE_COMPUTER_TOOL_NAMES = [
  "mouse_move",
  "mouse_click",
  "mouse_scroll",
  "keyboard_type",
  "keyboard_press",
  "screenshot",
  "get_screen_size",
  "get_mouse_position",
  "wait",
  "start_live_view",
  "stop_live_view",
  "request_human_approval",
  "is_human_intervening",
] as const;

export type NativeComputerToolName = (typeof NATIVE_COMPUTER_TOOL_NAMES)[number];

type NativeComputerOutput = Record<string, unknown>;
type MouseButton = "left" | "middle" | "right";
type NutModule = typeof import("@nut-tree-fork/nut-js");

interface Point {
  x: number;
  y: number;
}

interface RegionInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingApproval {
  id: string;
  reason: string;
  contextScreenshot?: string | undefined;
  createdAt: string;
  resolve: (decision: "approved" | "denied" | "take_over_completed" | "timeout") => void;
}

const require = createRequire(import.meta.url);
const ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_LIVE_HOST = "127.0.0.1";
const DEFAULT_LIVE_PORT = 8765;
const SCROLL_LOCK_KEYCODE = 70;

const dangerousKeyCombos = new Set([
  "ctrl+alt+delete",
  "ctrl+alt+del",
  "cmd+power",
  "command+power",
  "meta+power",
  "alt+f4",
]);

export class NativeComputerController {
  private server: Server | undefined;
  private liveUrl: string | undefined;
  private approvalUrl: string | undefined;
  private pendingApproval: PendingApproval | undefined;
  private humanIntervening = false;
  private killSwitchActive = false;
  private killSwitchStarted = false;
  private scrollLockPresses: number[] = [];
  private lastActionAt = Date.now();

  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.liveUrl = undefined;
    this.approvalUrl = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async execute(name: NativeComputerToolName, args: Record<string, unknown>, runtime: ToolRuntimeMetadata): Promise<NativeComputerOutput> {
    await this.ensureKillSwitchListener();
    if (name === "start_live_view") return this.startLiveView(args, runtime);
    if (name === "stop_live_view") {
      await this.close();
      return { success: true, stopped: true };
    }

    return this.runLoggedAction(name, args, runtime, async () => {
      this.assertKillSwitchClear();
      switch (name) {
        case "mouse_move":
          return this.mouseMove(args);
        case "mouse_click":
          return this.mouseClick(args);
        case "mouse_scroll":
          return this.mouseScroll(args);
        case "keyboard_type":
          return this.keyboardType(args);
        case "keyboard_press":
          return this.keyboardPress(args);
        case "screenshot":
          return this.screenshot(args, runtime);
        case "get_screen_size":
          return this.getScreenSize();
        case "get_mouse_position":
          return this.getMousePosition();
        case "wait":
          return this.wait(args);
        case "request_human_approval":
          return this.requestHumanApproval(args, runtime);
        case "is_human_intervening":
          return { success: true, humanIntervening: this.humanIntervening };
        default:
          return { success: false, error: `Unknown native computer tool: ${name}` };
      }
    });
  }

  private async runLoggedAction(
    name: NativeComputerToolName,
    args: Record<string, unknown>,
    runtime: ToolRuntimeMetadata,
    fn: () => Promise<NativeComputerOutput>,
  ): Promise<NativeComputerOutput> {
    await mkdir(runtime.artifactDir, { recursive: true });
    const startedAt = new Date().toISOString();
    let output: NativeComputerOutput;
    try {
      output = await withTimeout(fn(), ACTION_TIMEOUT_MS, `${name} timed out after ${ACTION_TIMEOUT_MS}ms`);
    } catch (error) {
      output = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        screenshot: await this.safeThumbnail(),
      };
    }
    this.lastActionAt = Date.now();
    await this.logAction(runtime, name, args, output, startedAt);
    return output;
  }

  private async mouseMove(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const target = await this.clampedPoint(numberArg(args, "x"), numberArg(args, "y"), nut);
    const duration = numberArg(args, "duration", 0.2);
    await this.moveMouseHumanized(nut, target, duration);
    return { success: true, x: target.x, y: target.y };
  }

  private async mouseClick(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const base = await this.clampedPoint(numberArg(args, "x"), numberArg(args, "y"), nut);
    const jitter = numberArg(args, "jitterPx", 3);
    const target = await this.clampedPoint(base.x + randomBetween(-jitter, jitter), base.y + randomBetween(-jitter, jitter), nut);
    const button = buttonArg(args);
    const clicks = Math.max(1, Math.min(5, Math.round(numberArg(args, "clicks", 1))));
    await this.moveMouseHumanized(nut, target, numberArg(args, "duration", 0.18));
    await sleep(randomBetween(60, 220));
    for (let index = 0; index < clicks; index += 1) {
      this.assertKillSwitchClear();
      await nut.mouse.click(toNutButton(nut, button));
      if (index < clicks - 1) await sleep(randomBetween(70, 180));
    }
    return { success: true, x: target.x, y: target.y, button, clicks };
  }

  private async mouseScroll(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const deltaX = numberArg(args, "deltaX", numberArg(args, "delta_x", 0));
    const deltaY = numberArg(args, "deltaY", numberArg(args, "delta_y", 0));
    const inertia = booleanArg(args, "inertia", true);
    const chunks = inertia ? clamp(Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 160), 3, 14) : 1;
    for (let index = 0; index < chunks; index += 1) {
      this.assertKillSwitchClear();
      const factor = inertia ? 1 - (index / chunks) * 0.45 : 1;
      const xSteps = Math.round((deltaX / chunks) * factor / 100);
      const ySteps = Math.round((deltaY / chunks) * factor / 100);
      if (ySteps > 0) await nut.mouse.scrollDown(Math.max(1, Math.abs(ySteps)));
      if (ySteps < 0) await nut.mouse.scrollUp(Math.max(1, Math.abs(ySteps)));
      if (xSteps > 0) await nut.mouse.scrollRight(Math.max(1, Math.abs(xSteps)));
      if (xSteps < 0) await nut.mouse.scrollLeft(Math.max(1, Math.abs(xSteps)));
      if (inertia && Math.random() < 0.03 && ySteps !== 0) {
        if (ySteps > 0) await nut.mouse.scrollUp(1);
        else await nut.mouse.scrollDown(1);
      }
      await sleep(inertia ? randomBetween(55, 180) : 0);
    }
    return { success: true, deltaX, deltaY, inertia };
  }

  private async keyboardType(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const text = stringArg(args, "text");
    const minDelay = numberArg(args, "minDelay", numberArg(args, "min_delay", 0.05));
    const maxDelay = numberArg(args, "maxDelay", numberArg(args, "max_delay", 0.25));
    const typoProbability = clamp(numberArg(args, "typoProbability", numberArg(args, "typo_probability", 0)), 0, 0.15);
    let typedChars = 0;
    for (const char of text) {
      this.assertKillSwitchClear();
      if (typoProbability > 0 && isTypableChar(char) && Math.random() < typoProbability) {
        await nut.keyboard.type(randomTypoChar());
        await sleep(randomBetween(minDelay * 1000, maxDelay * 1000));
        await nut.keyboard.type(nut.Key.Backspace);
      }
      await nut.keyboard.type(char);
      typedChars += 1;
      await sleep(randomBetween(minDelay * 1000, maxDelay * 1000));
    }
    return { success: true, typedChars };
  }

  private async keyboardPress(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const keys = stringArrayArg(args, "keys");
    const combo = normalizeCombo(keys);
    if (dangerousKeyCombos.has(combo) && !booleanArg(args, "authorized", false)) {
      return { success: false, error: `Blocked dangerous key combination: ${combo}`, blocked: true };
    }
    const keyCodes = keys.map((key) => toNutKey(nut, key));
    await sleep(randomBetween(20, 90));
    await nut.keyboard.pressKey(...keyCodes);
    await sleep(numberArg(args, "duration", 0.1) * 1000);
    await nut.keyboard.releaseKey(...keyCodes.slice().reverse());
    return { success: true, keys, combo };
  }

  private async screenshot(args: Record<string, unknown>, runtime: ToolRuntimeMetadata): Promise<NativeComputerOutput> {
    const region = regionArg(args.region);
    const returnFormat = typeof args.returnFormat === "string" ? args.returnFormat : typeof args.return_format === "string" ? args.return_format : "base64";
    const buffer = await screenshotBuffer(region);
    if (returnFormat === "path") {
      await mkdir(runtime.artifactDir, { recursive: true });
      const screenshotPath = path.join(runtime.artifactDir, `${runtime.toolCallId || randomUUID()}.png`);
      await writeFile(screenshotPath, buffer);
      return { success: true, path: screenshotPath, bytes: buffer.length };
    }
    return { success: true, base64: buffer.toString("base64"), bytes: buffer.length };
  }

  private async getScreenSize(): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const [width, height] = await Promise.all([nut.screen.width(), nut.screen.height()]);
    return { success: true, width, height };
  }

  private async getMousePosition(): Promise<NativeComputerOutput> {
    const nut = await loadNut();
    const position = await nut.mouse.getPosition();
    return { success: true, x: position.x, y: position.y };
  }

  private async wait(args: Record<string, unknown>): Promise<NativeComputerOutput> {
    const seconds = numberArg(args, "seconds", 0);
    const jitter = numberArg(args, "jitter", 0.2);
    const actualSeconds = Math.max(0, seconds + randomBetween(-jitter, jitter));
    await sleep(actualSeconds * 1000);
    return { success: true, waitedSeconds: actualSeconds };
  }

  private async startLiveView(args: Record<string, unknown>, runtime: ToolRuntimeMetadata): Promise<NativeComputerOutput> {
    if (this.server) {
      return { success: true, url: this.liveUrl, approvalUrl: this.approvalUrl, alreadyRunning: true };
    }
    const host = typeof args.host === "string" ? args.host : DEFAULT_LIVE_HOST;
    const port = typeof args.port === "number" ? args.port : DEFAULT_LIVE_PORT;
    this.liveUrl = `http://${host}:${port}/live`;
    this.approvalUrl = `http://${host}:${port}/`;
    this.server = createServer((request, response) => {
      void this.handleLiveRequest(request, response, runtime, args).catch((error) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => resolve());
    });
    return { success: true, url: this.liveUrl, approvalUrl: this.approvalUrl };
  }

  private async requestHumanApproval(args: Record<string, unknown>, runtime: ToolRuntimeMetadata): Promise<NativeComputerOutput> {
    if (getComputerTunables().autoApprove === true) {
      return { success: true, decision: "approved", autoApproved: true };
    }
    await this.startLiveView({}, runtime);
    const timeoutMs = numberArg(args, "timeoutMs", numberArg(args, "timeoutSeconds", 300)) * 1000;
    const reason = stringArg(args, "reason");
    const id = randomUUID();
    const contextScreenshot = typeof args.contextScreenshot === "string" ? args.contextScreenshot : await this.safeThumbnail();
    const decision = await new Promise<"approved" | "denied" | "take_over_completed" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApproval?.id === id) this.pendingApproval = undefined;
        resolve("timeout");
      }, timeoutMs);
      this.pendingApproval = {
        id,
        reason,
        contextScreenshot,
        createdAt: new Date().toISOString(),
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
    });
    const success = decision === "approved" || decision === "take_over_completed";
    return { success, decision, approvalUrl: this.approvalUrl, liveUrl: this.liveUrl };
  }

  private async moveMouseHumanized(nut: NutModule, target: Point, durationSeconds: number): Promise<void> {
    const startPosition = await nut.mouse.getPosition();
    const start = { x: startPosition.x, y: startPosition.y };
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const steps = clamp(Math.round(distance / 18) + 8, 8, 80);
    const control1 = {
      x: start.x + (target.x - start.x) * 0.33 + randomBetween(-distance * 0.12, distance * 0.12),
      y: start.y + (target.y - start.y) * 0.33 + randomBetween(-distance * 0.12, distance * 0.12),
    };
    const control2 = {
      x: start.x + (target.x - start.x) * 0.66 + randomBetween(-distance * 0.1, distance * 0.1),
      y: start.y + (target.y - start.y) * 0.66 + randomBetween(-distance * 0.1, distance * 0.1),
    };
    const sleepPerStep = Math.max(0, (durationSeconds * 1000) / steps);
    for (let index = 1; index <= steps; index += 1) {
      this.assertKillSwitchClear();
      const point = cubicBezier(start, control1, control2, target, index / steps);
      const jitter = index === steps ? 0 : randomBetween(-1.8, 1.8);
      const clamped = await this.clampedPoint(point.x + jitter, point.y + jitter, nut);
      await nut.mouse.setPosition(new nut.Point(clamped.x, clamped.y));
      await sleep(sleepPerStep * randomBetween(0.65, 1.35));
    }
    if (distance > 60 && Math.random() < 0.25) {
      const overshoot = await this.clampedPoint(target.x + randomBetween(-7, 7), target.y + randomBetween(-7, 7), nut);
      await nut.mouse.setPosition(new nut.Point(overshoot.x, overshoot.y));
      await sleep(randomBetween(25, 85));
      await nut.mouse.setPosition(new nut.Point(target.x, target.y));
    }
  }

  private async clampedPoint(x: number, y: number, nut: NutModule): Promise<Point> {
    const [width, height] = await Promise.all([nut.screen.width(), nut.screen.height()]);
    return {
      x: Math.round(clamp(x, 0, Math.max(0, width - 1))),
      y: Math.round(clamp(y, 0, Math.max(0, height - 1))),
    };
  }

  private async handleLiveRequest(request: IncomingMessage, response: ServerResponse, runtime: ToolRuntimeMetadata, args: Record<string, unknown>): Promise<void> {
    const url = new URL(request.url ?? "/", this.approvalUrl ?? "http://127.0.0.1:8765/");
    if (url.pathname === "/live") {
      await this.streamLiveView(response, args);
      return;
    }
    if (url.pathname === "/status") {
      writeJson(response, {
        humanIntervening: this.humanIntervening,
        pendingApproval: this.pendingApproval ? { id: this.pendingApproval.id, reason: this.pendingApproval.reason, createdAt: this.pendingApproval.createdAt } : null,
      });
      return;
    }
    if (url.pathname.startsWith("/approval/")) {
      const decision = url.pathname.split("/").pop();
      if (!this.pendingApproval) {
        response.end(renderPage("No pending approval", "<p>No approval is pending.</p>"));
        return;
      }
      if (decision === "approve") {
        this.pendingApproval.resolve("approved");
        this.pendingApproval = undefined;
        response.end(renderPage("Approved", "<p>Approved. The agent may continue.</p>"));
        return;
      }
      if (decision === "deny") {
        this.pendingApproval.resolve("denied");
        this.pendingApproval = undefined;
        response.end(renderPage("Denied", "<p>Denied. The agent will receive a denial result.</p>"));
        return;
      }
      if (decision === "take-over") {
        this.humanIntervening = true;
        response.end(renderPage("Take Over", "<p>Human takeover is active. The agent is paused until you release control.</p><p><a href='/release'>Release control</a></p>"));
        return;
      }
    }
    if (url.pathname === "/release") {
      this.humanIntervening = false;
      if (this.pendingApproval) {
        this.pendingApproval.resolve("take_over_completed");
        this.pendingApproval = undefined;
      }
      response.end(renderPage("Released", "<p>Control released. The agent may continue.</p>"));
      return;
    }
    if (url.pathname === "/kill") {
      this.killSwitchActive = true;
      response.end(renderPage("Kill Switch", "<p>Emergency stop activated.</p>"));
      return;
    }
    response.end(renderSupervisorPage(this.liveUrl ?? "/live", this.pendingApproval, this.humanIntervening, runtime.artifactDir));
  }

  private async streamLiveView(response: ServerResponse, args: Record<string, unknown>): Promise<void> {
    response.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Connection: "close",
    });
    const fps = clamp(Math.round(numberArg(args, "fps", 8)), 1, 20);
    let closed = false;
    response.on("close", () => {
      closed = true;
    });
    while (!closed && !this.killSwitchActive) {
      try {
        const buffer = await screenshotBuffer(undefined, "jpg");
        response.write(Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`));
        response.write(buffer);
        response.write(Buffer.from("\r\n"));
      } catch {
        await sleep(500);
      }
      await sleep(1000 / fps);
    }
    response.end();
  }

  private async ensureKillSwitchListener(): Promise<void> {
    if (this.killSwitchStarted) return;
    this.killSwitchStarted = true;
    if (!canStartGlobalKeyboardHook()) return;
    try {
      const { uIOhook } = await import("uiohook-napi");
      uIOhook.on("keydown", (event) => {
        if (event.keycode !== SCROLL_LOCK_KEYCODE) return;
        const now = Date.now();
        this.scrollLockPresses = this.scrollLockPresses.filter((value) => now - value <= 2000);
        this.scrollLockPresses.push(now);
        if (this.scrollLockPresses.length >= 3) {
          this.killSwitchActive = true;
          this.humanIntervening = false;
          this.pendingApproval?.resolve("denied");
          this.pendingApproval = undefined;
        }
      });
      uIOhook.start();
    } catch {
      // Native keyboard hooks need desktop permissions and platform libraries.
      // Tools still work; explicit /kill remains available from the supervisor UI.
    }
  }

  private assertKillSwitchClear(): void {
    if (!this.killSwitchActive) return;
    this.killSwitchActive = false;
    throw new Error("Emergency kill switch activated; action cancelled and tool state reset");
  }

  private async logAction(
    runtime: ToolRuntimeMetadata,
    name: NativeComputerToolName,
    args: Record<string, unknown>,
    output: NativeComputerOutput,
    startedAt: string,
  ): Promise<void> {
    const redactedArgs = { ...args };
    if (typeof redactedArgs.text === "string") redactedArgs.text = `<${redactedArgs.text.length} chars>`;
    const entry = {
      timestamp: new Date().toISOString(),
      startedAt,
      toolCallId: runtime.toolCallId,
      action: name,
      args: redactedArgs,
      success: output.success === true,
      error: output.error,
      thumbnail: await this.safeThumbnail(),
      msSincePreviousAction: Date.now() - this.lastActionAt,
    };
    await appendFile(path.join(runtime.artifactDir, "computer_control.log"), `${JSON.stringify(entry)}\n`, "utf8").catch(() => undefined);
  }

  private async safeThumbnail(): Promise<string | undefined> {
    try {
      const buffer = await screenshotBuffer(undefined, "jpg");
      return buffer.subarray(0, 200_000).toString("base64");
    } catch {
      return undefined;
    }
  }
}

function canStartGlobalKeyboardHook(): boolean {
  if (getComputerTunables().enableGlobalHook === false) return false;
  if (getComputerTunables().enableGlobalHook === true) return true;
  if (process.platform !== "linux") return true;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  const result = spawnSync("sh", ["-lc", "command -v xrandr >/dev/null 2>&1"], { stdio: "ignore" });
  return result.status === 0;
}

async function loadNut(): Promise<NutModule> {
  const readinessError = nativeDesktopReadinessError();
  if (readinessError) throw new Error(readinessError);
  try {
    return await import("@nut-tree-fork/nut-js");
  } catch (error) {
    throw new Error(
      `Native desktop automation is unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
        "Install the platform desktop libraries and grant accessibility/screen-recording permissions.",
    );
  }
}

function nativeDesktopReadinessError(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Native desktop automation is unavailable: no DISPLAY or WAYLAND_DISPLAY is set.";
  }
  const xrandr = spawnSync("sh", ["-lc", "command -v xrandr >/dev/null 2>&1"], { stdio: "ignore" });
  if (xrandr.status !== 0) {
    return "Native desktop automation is unavailable: xrandr is not installed.";
  }
  return undefined;
}

async function screenshotBuffer(region?: RegionInput | undefined, format: "png" | "jpg" = "png"): Promise<Buffer> {
  const readinessError = screenshotReadinessError();
  if (readinessError) throw new Error(readinessError);
  const screenshot = require("screenshot-desktop") as (options?: Record<string, unknown>) => Promise<Buffer | string>;
  let buffer = await screenshot({ format });
  if (typeof buffer === "string") {
    throw new Error(`screenshot-desktop returned path unexpectedly: ${buffer}`);
  }
  if (!region) return buffer;

  const Jimp = require("jimp") as any;
  const image = await Jimp.read(buffer);
  image.crop(region.x, region.y, region.width, region.height);
  buffer = (await image.getBufferAsync(format === "jpg" ? Jimp.MIME_JPEG : Jimp.MIME_PNG)) as Buffer;
  return buffer;
}

function screenshotReadinessError(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return "Screen capture is unavailable: no DISPLAY or WAYLAND_DISPLAY is set.";
  }
  const xrandr = spawnSync("sh", ["-lc", "command -v xrandr >/dev/null 2>&1"], { stdio: "ignore" });
  if (xrandr.status !== 0) {
    return "Screen capture is unavailable: xrandr is not installed.";
  }
  return undefined;
}

function renderSupervisorPage(liveUrl: string, pending: PendingApproval | undefined, humanIntervening: boolean, artifactDir: string): string {
  const approval = pending
    ? `<section><h2>Approval Required</h2><p>${escapeHtml(pending.reason)}</p><p><a href="/approval/approve">Approve</a> <a href="/approval/deny">Deny</a> <a href="/approval/take-over">Take Over</a></p></section>`
    : "<section><h2>No Pending Approval</h2></section>";
  return renderPage(
    "Reaper Computer Control",
    `<p>Live stream: <a href="/live">${escapeHtml(liveUrl)}</a></p><p>Human takeover: ${humanIntervening ? "active" : "inactive"}</p>${approval}<section><img src="/live" style="max-width:100%;height:auto;border:1px solid #ccc"></section><p>Logs: ${escapeHtml(path.join(artifactDir, "computer_control.log"))}</p><p><a href="/kill">Emergency stop</a></p>`,
  );
}

function renderPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.45}a{display:inline-block;margin-right:12px}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
}

function toNutButton(nut: NutModule, button: MouseButton): number {
  if (button === "right") return nut.Button.RIGHT;
  if (button === "middle") return nut.Button.MIDDLE;
  return nut.Button.LEFT;
}

function toNutKey(nut: NutModule, key: string): number {
  const normalized = normalizeKeyName(key);
  const keyMap: Record<string, number> = {
    ctrl: nut.Key.LeftControl,
    control: nut.Key.LeftControl,
    alt: nut.Key.LeftAlt,
    shift: nut.Key.LeftShift,
    cmd: nut.Key.LeftCmd,
    command: nut.Key.LeftCmd,
    meta: nut.Key.LeftMeta,
    win: nut.Key.LeftWin,
    super: nut.Key.LeftSuper,
    enter: nut.Key.Return,
    return: nut.Key.Return,
    escape: nut.Key.Escape,
    esc: nut.Key.Escape,
    tab: nut.Key.Tab,
    space: nut.Key.Space,
    backspace: nut.Key.Backspace,
    delete: nut.Key.Delete,
    del: nut.Key.Delete,
    up: nut.Key.Up,
    down: nut.Key.Down,
    left: nut.Key.Left,
    right: nut.Key.Right,
    home: nut.Key.Home,
    end: nut.Key.End,
    pageup: nut.Key.PageUp,
    pagedown: nut.Key.PageDown,
  };
  if (keyMap[normalized] !== undefined) return keyMap[normalized];
  const functionMatch = /^f([1-9]|1\d|2[0-4])$/.exec(normalized);
  if (functionMatch) return (nut.Key as unknown as Record<string, number>)[`F${functionMatch[1]}`] ?? nut.Key.F1;
  if (/^[a-z]$/.test(normalized)) return (nut.Key as unknown as Record<string, number>)[normalized.toUpperCase()] ?? nut.Key.Space;
  if (/^\d$/.test(normalized)) return (nut.Key as unknown as Record<string, number>)[`Num${normalized}`] ?? nut.Key.Space;
  throw new Error(`Unsupported key: ${key}`);
}

function buttonArg(args: Record<string, unknown>): MouseButton {
  const button = typeof args.button === "string" ? args.button : "left";
  if (button === "left" || button === "middle" || button === "right") return button;
  throw new Error(`Unsupported mouse button: ${button}`);
}

function numberArg(args: Record<string, unknown>, name: string, fallback?: number): number {
  const value = args[name];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing numeric ${name}`);
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value === "string") return value;
  throw new Error(`Missing string ${name}`);
}

function stringArrayArg(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error(`Missing string[] ${name}`);
}

function booleanArg(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (typeof value === "boolean") return value;
  return fallback;
}

function regionArg(value: unknown): RegionInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number")) {
    const [x, y, width, height] = value as [number, number, number, number];
    return { x, y, width, height };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.x === "number" && typeof record.y === "number" && typeof record.width === "number" && typeof record.height === "number") {
      return { x: record.x, y: record.y, width: record.width, height: record.height };
    }
  }
  throw new Error("region must be [x, y, width, height] or {x,y,width,height}");
}

function normalizeCombo(keys: string[]): string {
  return keys.map(normalizeKeyName).join("+");
}

function normalizeKeyName(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, "").replace("arrow", "").replace("control", "ctrl").replace("delete", "del");
}

function cubicBezier(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt ** 3 * start.x + 3 * mt ** 2 * t * c1.x + 3 * mt * t ** 2 * c2.x + t ** 3 * end.x,
    y: mt ** 3 * start.y + 3 * mt ** 2 * t * c1.y + 3 * mt * t ** 2 * c2.y + t ** 3 * end.y,
  };
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTypableChar(value: string): boolean {
  return value.length === 1 && /[a-zA-Z]/.test(value);
}

function randomTypoChar(): string {
  return "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)] ?? "x";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}
