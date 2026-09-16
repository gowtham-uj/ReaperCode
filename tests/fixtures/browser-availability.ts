/**
 * Is there a browser, and if not, why not.
 *
 * The browser tests skip when Steel is not running, which keeps the suite
 * useful on a machine that has never started it. That is right, and it hid a
 * crash for a long time: Steel dying mid-run produced exactly the same
 * "no browser" as never having started it, so a broken browser looked like an
 * absent one and the suite reported seven skips instead of one failure.
 *
 * So the probe distinguishes the cases rather than answering yes or no:
 *
 *   absent    nothing is listening on the port. Start Steel.
 *   dying     something is listening but does not speak CDP. This is the one
 *             that matters, because it means Steel is up but broken, and it is
 *             what the crash looked like.
 *   reachable a browser answered.
 *
 * Setting `REAPER_REQUIRE_BROWSER=1` turns every skip into a failure, which is
 * what CI wants: a suite that silently skips its browser coverage reports green
 * while testing nothing.
 */

import { chromium } from "playwright";

export interface BrowserAvailability {
  /** True only when a browser answered over CDP. */
  available: boolean;
  /** The CDP endpoint that was probed. */
  cdpUrl: string;
  /**
   * Why it is unavailable, in words that distinguish an absent browser from a
   * broken one. Undefined when `available`.
   */
  reason?: string | undefined;
}

/** True when something is listening on the port, whether or not it is a browser. */
async function portOpen(cdpUrl: string): Promise<boolean> {
  try {
    const url = new URL(cdpUrl);
    const port = url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const { Socket } = await import("node:net");
    return await new Promise<boolean>((resolve) => {
      const socket = new Socket();
      const done = (open: boolean): void => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(1_000);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, url.hostname);
    });
  } catch {
    return false;
  }
}

/**
 * Probe the browser once, with the failure modes kept apart.
 *
 * The CDP version endpoint is checked as well as the socket, because a port
 * that accepts connections and does not answer `/json/version` is a process in
 * trouble rather than a browser, and that distinction is the whole point.
 */
/**
 * How long the connect is given, and how many times.
 *
 * Five seconds was the first number and it was wrong in a way that produced a
 * false alarm: on a machine running the whole browser suite at load 2, a healthy
 * Steel that is merely busy took longer than that, and the fixture reported
 * "something is listening but it does not speak CDP" — a diagnosis of a dead
 * process for a process that was fine. That message is the fixture's whole
 * purpose, so getting it wrong in the direction of a false positive is the worst
 * way for it to fail.
 *
 * Three attempts of ten seconds. A Steel that is up answers the first one; one
 * under load answers a later one; one that is genuinely crashed never answers,
 * which is the case the message is for.
 */
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const CDP_CONNECT_ATTEMPTS = 3;

export async function probeBrowser(cdpUrl: string): Promise<BrowserAvailability> {
  let lastMessage = "unknown error";
  for (let attempt = 0; attempt < CDP_CONNECT_ATTEMPTS; attempt++) {
    try {
      const browser = await chromium.connectOverCDP(cdpUrl, { timeout: CDP_CONNECT_TIMEOUT_MS });
      await browser.close();
      return { available: true, cdpUrl };
    } catch (error) {
      lastMessage = (error as Error).message.split("\n")[0] ?? "unknown error";
      /*
       * A refused connection is final: nothing is listening, so retrying only
       * delays a report that is already certain.
       */
      if (await portOpen(cdpUrl) === false) break;
    }
  }

  const listening = await portOpen(cdpUrl);
  if (!listening) {
    return {
      available: false,
      cdpUrl,
      reason: `nothing is listening on ${cdpUrl}, so Steel is not running`,
    };
  }
  return {
    available: false,
    cdpUrl,
    reason:
      `something is listening on ${cdpUrl} but it does not speak CDP after ${CDP_CONNECT_ATTEMPTS} attempts of ` +
      `${CDP_CONNECT_TIMEOUT_MS}ms (${lastMessage}). ` +
      `This is what a crashed or half-started Steel looks like, and it is not the same as Steel being absent.`,
  };
}

/** The `skip` option for a test, or false when it should run. */
export function skipUnless(availability: BrowserAvailability): false | string {
  if (availability.available) {
    /*
     * Under REAPER_REQUIRE_BROWSER the tests must fail rather than skip, so a
     * missing browser is not passed off as a green run.
     */
    if (process.env["REAPER_REQUIRE_BROWSER"] === "1") return false;
    return false;
  }
  if (process.env["REAPER_REQUIRE_BROWSER"] === "1") {
    throw new Error(`REAPER_REQUIRE_BROWSER=1 but the browser is unavailable: ${availability.reason ?? "unknown"}`);
  }
  return availability.reason ?? "the browser is unavailable";
}
