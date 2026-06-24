import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Locator, type Page } from "playwright";

import type { BrowserControlArgs, ComputerControlArgs } from "../types.js";

export interface ToolRuntimeMetadata {
  runId: string;
  artifactDir: string;
  toolCallId: string;
}

type BrowserOutput = Record<string, unknown>;

const INTERACTIVE_SELECTOR = "a, button, input, textarea, select, [role=button], [role=link], [contenteditable=true]";
const DEFAULT_MAX_INTERACTIVE = 80;
const extractInteractiveElements = new Function(
  "elements",
  "limit",
  `
  const cssEscape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => "\\\\" + char);
  const selectorHint = (element) => {
    const id = element.getAttribute("id");
    if (id) return "#" + cssEscape(id);
    const dataTestId = element.getAttribute("data-testid");
    if (dataTestId) return '[data-testid="' + dataTestId.replace(/"/g, '\\\\"') + '"]';
    const name = element.getAttribute("name");
    if (name) return element.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    return element.tagName.toLowerCase();
  };
  const items = [];
  for (const [index, element] of elements.entries()) {
    if (items.length >= Number(limit)) break;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") {
      continue;
    }
    const text = (element.innerText || element.getAttribute("aria-label") || element.getAttribute("title") || element.placeholder || element.value || "").trim().slice(0, 160);
    const item = {
      ref: "e" + index,
      index,
      tag: element.tagName.toLowerCase(),
      text,
      selectorHint: selectorHint(element),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
    const role = element.getAttribute("role");
    if (role) item.role = role;
    if (element.type) item.type = element.type;
    items.push(item);
  }
  return items;
  `,
) as (elements: Element[], limit: number) => InteractiveElement[];

interface PageOptions {
  width?: number | undefined;
  height?: number | undefined;
  headless?: boolean | undefined;
}

interface DescribePageOptions {
  screenshot?: boolean | undefined;
  fullPage?: boolean | undefined;
  maxTextChars?: number | undefined;
  maxInteractive?: number | undefined;
  action?: string | undefined;
}

interface Point {
  x: number;
  y: number;
}

interface InteractiveElement {
  ref: string;
  index: number;
  tag: string;
  text: string;
  selectorHint: string;
  x: number;
  y: number;
  width: number;
  height: number;
  role?: string | undefined;
  type?: string | undefined;
}

export class ComputerBrowserController {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private headless: boolean | undefined;
  private lastMouse: Point | undefined;

  async close(): Promise<void> {
    const browser = this.browser;
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
    this.headless = undefined;
    this.lastMouse = undefined;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }

  async browserControl(args: BrowserControlArgs, runtime: ToolRuntimeMetadata): Promise<BrowserOutput> {
    if (args.action === "close") {
      await this.close();
      return { action: args.action, status: "closed" };
    }

    const page = await this.ensurePage(args);
    const timeoutMs = args.timeoutMs ?? 15_000;

    switch (args.action) {
      case "navigate": {
        if (!args.url) throw new Error("browser_control navigate requires args.url");
        await page.goto(normalizeUrl(args.url), { waitUntil: args.waitUntil ?? "domcontentloaded", timeout: timeoutMs });
        return this.describePage(page, args, runtime);
      }
      case "snapshot":
        return this.describePage(page, args, runtime);
      case "screenshot":
        return this.describePage(page, { ...args, screenshot: true }, runtime);
      case "click": {
        await this.clickTarget(page, args, timeoutMs);
        return this.describePage(page, args, runtime);
      }
      case "type": {
        if (args.text === undefined) throw new Error("browser_control type requires args.text");
        const locator = fieldLocator(page, args);
        if (locator) {
          if (args.clear !== false) {
            if (args.humanize) {
              await this.clickLocator(page, locator, timeoutMs, args.button ?? "left", true);
              await locator.fill("", { timeout: timeoutMs });
              await this.keyboardType(page, args.text, true);
            } else {
              await locator.fill(args.text, { timeout: timeoutMs });
            }
          } else {
            if (args.humanize) {
              await this.clickLocator(page, locator, timeoutMs, args.button ?? "left", true);
              await this.keyboardType(page, args.text, true);
            } else {
              await locator.type(args.text, { timeout: timeoutMs });
            }
          }
        } else {
          await this.keyboardType(page, args.text, args.humanize ?? false);
        }
        if (args.submit) {
          await page.keyboard.press("Enter");
        }
        return this.describePage(page, args, runtime);
      }
      case "press": {
        if (!args.key) throw new Error("browser_control press requires args.key");
        await page.keyboard.press(args.key);
        return this.describePage(page, args, runtime);
      }
      case "select": {
        const locator = fieldLocator(page, args);
        if (!locator) throw new Error("browser_control select requires selector or ref");
        if (args.value === undefined) throw new Error("browser_control select requires args.value");
        await locator.selectOption(args.value, { timeout: timeoutMs });
        return this.describePage(page, args, runtime);
      }
      case "scroll": {
        const locator = fieldLocator(page, args);
        if (locator) {
          await locator.evaluate((el, deltaY) => {
            el.scrollBy(0, Number(deltaY));
          }, args.deltaY ?? 600);
        } else {
          await this.wheel(page, args.deltaX ?? 0, args.deltaY ?? 600, args.humanize ?? false);
        }
        return this.describePage(page, args, runtime);
      }
    }
  }

  async computerControl(args: ComputerControlArgs, runtime: ToolRuntimeMetadata): Promise<BrowserOutput> {
    const page = await this.ensurePage(args);
    const mouseButton = args.button ?? "left";

    switch (args.action) {
      case "screenshot":
        return this.describePage(page, { action: "snapshot", screenshot: true, fullPage: args.fullPage }, runtime);
      case "move": {
        requireCoordinate(args.x, "x");
        requireCoordinate(args.y, "y");
        await this.moveMouse(page, args.x, args.y, args.humanize ?? false, args.steps);
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "click": {
        requireCoordinate(args.x, "x");
        requireCoordinate(args.y, "y");
        await this.clickPoint(page, args.x, args.y, mouseButton, args.humanize ?? false);
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "double_click": {
        requireCoordinate(args.x, "x");
        requireCoordinate(args.y, "y");
        if (args.humanize) {
          await this.moveMouse(page, args.x, args.y, true, args.steps);
          await page.mouse.down({ button: mouseButton });
          await sleep(randomBetween(45, 130));
          await page.mouse.up({ button: mouseButton });
          await sleep(randomBetween(75, 180));
          await page.mouse.down({ button: mouseButton });
          await sleep(randomBetween(45, 130));
          await page.mouse.up({ button: mouseButton });
        } else {
          await page.mouse.dblclick(args.x, args.y, { button: mouseButton });
          this.lastMouse = { x: args.x, y: args.y };
        }
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "drag": {
        requireCoordinate(args.x, "x");
        requireCoordinate(args.y, "y");
        requireCoordinate(args.endX, "endX");
        requireCoordinate(args.endY, "endY");
        await this.moveMouse(page, args.x, args.y, args.humanize ?? false, args.steps);
        await page.mouse.down({ button: mouseButton });
        await this.moveMouse(page, args.endX, args.endY, args.humanize ?? false, args.steps);
        await page.mouse.up({ button: mouseButton });
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "type": {
        if (args.text === undefined) throw new Error("computer_control type requires args.text");
        await this.keyboardType(page, args.text, args.humanize ?? false);
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "press": {
        if (!args.key) throw new Error("computer_control press requires args.key");
        await page.keyboard.press(args.key);
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
      case "scroll": {
        await this.wheel(page, args.deltaX ?? 0, args.deltaY ?? 600, args.humanize ?? false);
        return this.describePage(page, { action: "snapshot" }, runtime);
      }
    }
  }

  private async ensurePage(options: PageOptions): Promise<Page> {
    const requestedHeadless = options.headless ?? process.env.REAPER_BROWSER_HEADLESS !== "0";
    if (this.browser && this.headless !== requestedHeadless) {
      await this.close();
    }
    if (!this.browser) {
      const launchOptions: LaunchOptions = {
        headless: requestedHeadless,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      };
      if (process.env.REAPER_BROWSER_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.REAPER_BROWSER_EXECUTABLE_PATH;
      }
      this.browser = await chromium.launch(launchOptions);
      this.headless = requestedHeadless;
    }
    const viewport = {
      width: options.width ?? 1280,
      height: options.height ?? 900,
    };
    if (!this.context) {
      this.context = await this.browser.newContext({ viewport });
    } else if (options.width || options.height) {
      await this.context.setDefaultTimeout(15_000);
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }
    if (options.width || options.height) {
      await this.page.setViewportSize(viewport);
    }
    return this.page;
  }

  private async describePage(page: Page, args: DescribePageOptions, runtime: ToolRuntimeMetadata): Promise<BrowserOutput> {
    const maxTextChars = args.maxTextChars ?? 12_000;
    const maxInteractive = args.maxInteractive ?? DEFAULT_MAX_INTERACTIVE;
    const [title, text, interactive] = await Promise.all([
      page.title().catch(() => ""),
      page.locator("body").innerText({ timeout: 2_000 }).catch(() => ""),
      getInteractiveElements(page, maxInteractive),
    ]);

    let screenshotPath: string | undefined;
    if (args.screenshot) {
      await mkdir(runtime.artifactDir, { recursive: true });
      screenshotPath = path.join(runtime.artifactDir, `${sanitizeFilename(runtime.toolCallId)}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: args.fullPage ?? false });
    }

    const viewport = page.viewportSize();
    const renderedText = text.length > maxTextChars ? `${text.slice(0, maxTextChars)}\n... [truncated]` : text;
    return {
      url: page.url(),
      title,
      viewport,
      snapshotFormat: "browser-ref-v1",
      snapshot: compactSnapshot({
        url: page.url(),
        title,
        viewport,
        text,
        textLimit: Math.min(maxTextChars, 4_000),
        interactive,
      }),
      text: renderedText,
      textTruncated: text.length > maxTextChars,
      interactive,
      ...(screenshotPath ? { screenshotPath } : {}),
    };
  }

  private async clickTarget(page: Page, args: BrowserControlArgs, timeoutMs: number): Promise<void> {
    const locator = clickLocator(page, args);
    if (locator) {
      await this.clickLocator(page, locator, timeoutMs, args.button ?? "left", args.humanize ?? false);
      return;
    }
    if (typeof args.x === "number" && typeof args.y === "number") {
      await this.clickPoint(page, args.x, args.y, args.button ?? "left", args.humanize ?? false);
      return;
    }
    throw new Error("browser_control click requires selector, ref, text, or x/y coordinates");
  }

  private async clickLocator(page: Page, locator: Locator, timeoutMs: number, button: "left" | "right" | "middle", humanize: boolean): Promise<void> {
    if (!humanize) {
      await locator.click({ timeout: timeoutMs, button });
      return;
    }
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    const box = await locator.boundingBox();
    if (!box) {
      await locator.click({ timeout: timeoutMs, button });
      return;
    }
    const insetX = Math.min(12, box.width / 4);
    const insetY = Math.min(12, box.height / 4);
    const x = box.x + randomBetween(insetX, Math.max(insetX, box.width - insetX));
    const y = box.y + randomBetween(insetY, Math.max(insetY, box.height - insetY));
    await this.clickPoint(page, x, y, button, true);
  }

  private async clickPoint(page: Page, x: number, y: number, button: "left" | "right" | "middle", humanize: boolean): Promise<void> {
    if (!humanize) {
      await page.mouse.click(x, y, { button });
      this.lastMouse = { x, y };
      return;
    }
    await this.moveMouse(page, x, y, true);
    await sleep(randomBetween(80, 220));
    await page.mouse.down({ button });
    await sleep(randomBetween(45, 140));
    await page.mouse.up({ button });
  }

  private async moveMouse(page: Page, x: number, y: number, humanize: boolean, requestedSteps?: number | undefined): Promise<void> {
    if (!humanize) {
      await page.mouse.move(x, y, { steps: requestedSteps ?? 1 });
      this.lastMouse = { x, y };
      return;
    }
    const start = this.lastMouse ?? {
      x: Math.max(0, x - randomBetween(90, 220)),
      y: Math.max(0, y - randomBetween(60, 180)),
    };
    const distance = Math.hypot(x - start.x, y - start.y);
    const steps = requestedSteps ?? clamp(Math.round(distance / 55) + 8, 10, 34);
    const control = {
      x: (start.x + x) / 2 + randomBetween(-90, 90),
      y: (start.y + y) / 2 + randomBetween(-70, 70),
    };
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const point = quadraticBezier(start, control, { x, y }, t);
      const jitter = i === steps ? 0 : randomBetween(-1.6, 1.6);
      await page.mouse.move(point.x + jitter, point.y + jitter);
      await sleep(randomBetween(6, 22));
    }
    this.lastMouse = { x, y };
  }

  private async keyboardType(page: Page, text: string, humanize: boolean): Promise<void> {
    if (!humanize) {
      await page.keyboard.type(text);
      return;
    }
    for (const char of text) {
      await page.keyboard.type(char, { delay: randomBetween(25, 120) });
      if (Math.random() < 0.07) {
        await sleep(randomBetween(90, 260));
      }
    }
  }

  private async wheel(page: Page, deltaX: number, deltaY: number, humanize: boolean): Promise<void> {
    if (!humanize) {
      await page.mouse.wheel(deltaX, deltaY);
      return;
    }
    const chunks = clamp(Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 180), 3, 12);
    for (let i = 0; i < chunks; i += 1) {
      await page.mouse.wheel(deltaX / chunks, deltaY / chunks);
      await sleep(randomBetween(80, 220));
    }
  }
}

function clickLocator(page: Page, args: BrowserControlArgs): Locator | undefined {
  if (args.ref) return locatorForRef(page, args.ref);
  if (args.selector) return page.locator(args.selector).first();
  if (args.text) return page.getByText(args.text, { exact: false }).first();
  return undefined;
}

function fieldLocator(page: Page, args: Pick<BrowserControlArgs, "ref" | "selector">): Locator | undefined {
  if (args.ref) return locatorForRef(page, args.ref);
  if (args.selector) return page.locator(args.selector).first();
  return undefined;
}

function locatorForRef(page: Page, ref: string): Locator {
  const match = /^e(\d+)$/.exec(ref.trim());
  if (!match) throw new Error(`browser_control ref must look like e0, got ${ref}`);
  return page.locator(INTERACTIVE_SELECTOR).nth(Number(match[1]));
}

async function getInteractiveElements(page: Page, maxInteractive: number): Promise<InteractiveElement[]> {
  return page.locator(INTERACTIVE_SELECTOR).evaluateAll(extractInteractiveElements, maxInteractive);
}

function compactSnapshot(input: {
  url: string;
  title: string;
  viewport: { width: number; height: number } | null;
  text: string;
  textLimit: number;
  interactive: InteractiveElement[];
}): string {
  const lines = [`url: ${input.url}`];
  if (input.title) lines.push(`title: ${input.title}`);
  if (input.viewport) lines.push(`viewport: ${input.viewport.width}x${input.viewport.height}`);
  const text = collapseWhitespace(input.text).slice(0, input.textLimit);
  if (text) {
    lines.push("", "text:", text);
  }
  if (input.interactive.length > 0) {
    lines.push("", "interactive:");
    for (const element of input.interactive) {
      const attrs = [
        element.role ? `role=${element.role}` : undefined,
        element.type ? `type=${element.type}` : undefined,
      ].filter(Boolean);
      const suffix = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
      const label = element.text ? ` "${collapseWhitespace(element.text)}"` : "";
      lines.push(
        `[ref=${element.ref}] <${element.tag}${suffix}>${label} at (${element.x},${element.y}) ${element.width}x${element.height} selector=${element.selectorHint}`,
      );
    }
  }
  return lines.join("\n");
}

function selectorHint(element: Element): string {
  const id = element.getAttribute("id");
  if (id) return `#${cssEscape(id)}`;
  const dataTestId = element.getAttribute("data-testid");
  if (dataTestId) return `[data-testid="${dataTestId.replace(/"/g, '\\"')}"]`;
  const name = element.getAttribute("name");
  if (name) return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
  return element.tagName.toLowerCase();
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(?:https?|file|data|about):/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function requireCoordinate(value: number | undefined, name: string): asserts value is number {
  if (typeof value !== "number") {
    throw new Error(`computer_control requires numeric args.${name}`);
  }
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quadraticBezier(start: Point, control: Point, end: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
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
