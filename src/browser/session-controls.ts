/**
 * Browser settings the agent can change while it works.
 *
 * Everything here is applied from our side, per page, over the same CDP
 * connection the thread already uses. That is deliberate and it is what makes
 * these settings usable at all on this deployment:
 *
 * Steel Local is a single session (`session.service.ts` holds one
 * `activeSession`), and creating a session with a different configuration makes
 * Steel close the running browser before launching a new one
 * (`cdp.service.ts`, "Existing browser instance detected. Closing it before
 * launching a new one."). So a per-thread setting routed through Steel's session
 * API would kill Chrome for every other thread. Measured, not assumed: a session
 * created while another thread was attached failed with
 * `page_refresh: Failed to refresh primary page when reusing browser instance`.
 *
 * The page-level CDP path has none of that problem. `Emulation.setUserAgentOverride`,
 * `Emulation.setTimezoneOverride` and `Emulation.setDeviceMetricsOverride` are
 * per-session commands that change a live page without touching the process, and
 * they were verified to take effect on a page attached to Steel and to survive a
 * navigation. Request blocking is Playwright's own `route()`, which was verified
 * to coexist with the interception Steel installs on new targets.
 *
 * ## What is live and what is not
 *
 * Live, per thread, no restart: user agent, timezone, viewport, fullscreen,
 * ad blocking, bandwidth blocking.
 *
 * Launch-time, meaning they apply when Steel next starts the browser:
 * `userPreferences`, `persist`, extensions, and the custom fingerprint. Those
 * are process-level in Chrome and there is no per-page equivalent, so pretending
 * otherwise would be worse than saying so. `userPreferences` is accepted here so
 * the intent is recorded and applied at the next launch, and the setter's
 * return value says which case it was.
 */

import type { BrowserContext, Page } from "playwright";

/** Resource kinds a bandwidth setting can refuse to load. */
export interface BandwidthSettings {
  blockImages?: boolean;
  blockMedia?: boolean;
  blockStylesheets?: boolean;
  /** Extra hosts to refuse, beyond the built-in ad list. */
  blockHosts?: string[];
  /** URL substrings to refuse. */
  blockUrlPatterns?: string[];
}

/**
 * The settings one thread's browser is running under.
 *
 * Every field is optional and absent means "leave it alone", so a program that
 * sets only a timezone does not reset the user agent a previous call chose.
 */
export interface BrowserSettings {
  userAgent?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
  fullscreen?: boolean;
  blockAds?: boolean;
  bandwidth?: BandwidthSettings;
  /**
   * A phone rather than a desktop.
   *
   * Sites serve a different page to a phone, and some only work on one. Applied
   * through `Emulation.setUserAgentOverride` with a platform, plus device
   * metrics with `mobile: true` and touch emulation, which were each verified to
   * take effect on a live page.
   */
  mobile?: boolean;
  /**
   * Bring-your-own proxy.
   *
   * Steel Local's comparison table lists this as supported, and it is: a
   * per-context `proxy` was accepted over the CDP connection and traffic really
   * did route through it (proved by pointing it at a dead port and watching the
   * navigation fail with ERR_PROXY_CONNECTION_FAILED rather than succeed).
   *
   * It is per *context*, not per page, so changing it means rebuilding this
   * thread's context, which loses its pages. `setProxy` says so in its report
   * rather than pretending the change was live.
   */
  proxy?: { server: string; username?: string; password?: string };
  /** Recorded for the next launch; see the note on launch-time settings. */
  userPreferences?: Record<string, unknown>;
}

/** The user agent a phone presents, paired with the platform hint. */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MOBILE_PLATFORM = "iPhone";
const MOBILE_VIEWPORT = { width: 390, height: 844 };

export const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/**
 * Hosts that serve ads and trackers rather than content.
 *
 * A short list of well-known networks rather than a full blocklist: the point is
 * to cut the obvious noise from a page the model is reading, not to be a
 * privacy tool. A page that is mostly ads is a page the model should see less
 * of, and every entry here is a request that would otherwise be fetched and
 * rendered for nothing.
 */
const AD_HOSTS: ReadonlyArray<string> = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagmanager.com",
  "googletagservices.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "adsrvr.org",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "outbrain.com",
  "taboola.com",
  "scorecardresearch.com",
  "quantserve.com",
  "zedo.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "sharethrough.com",
  "teads.tv",
  "moatads.com",
  "adform.net",
  "smartadserver.com",
  "yieldmo.com",
  "bidswitch.net",
  "3lift.com",
  "contextweb.com",
];

/** True when a URL's host is one of the ad networks. */
export function isAdRequest(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AD_HOSTS.some((ad) => host === ad || host.endsWith(`.${ad}`));
}

/**
 * Whether a request should be refused under the active settings.
 *
 * Pure and exported so the rule is testable without a browser: the interesting
 * cases are the boundaries (an ad host with a port, a subdomain of an ad host,
 * and a host that merely ends with the same letters).
 */
export function shouldBlockRequest(
  request: { url: string; resourceType: string },
  settings: BrowserSettings,
): boolean {
  const bandwidth = settings.bandwidth;
  if (bandwidth) {
    const type = request.resourceType;
    if (bandwidth.blockImages === true && type === "image") return true;
    if (bandwidth.blockMedia === true && type === "media") return true;
    if (bandwidth.blockStylesheets === true && type === "stylesheet") return true;
    if (bandwidth.blockUrlPatterns?.some((pattern) => request.url.includes(pattern))) return true;
    if (bandwidth.blockHosts?.length) {
      try {
        const host = new URL(request.url).hostname.toLowerCase();
        if (bandwidth.blockHosts.some((blocked) => host === blocked.toLowerCase())) return true;
      } catch {
        /* an unparseable URL is not a host match */
      }
    }
  }
  if (settings.blockAds === true && isAdRequest(request.url)) return true;
  return false;
}

/**
 * One page's live control channel.
 *
 * Holds the CDP session used for the emulation overrides, because creating one
 * per call would add a round trip to every setting change. Attached lazily: a
 * thread that never changes a setting never opens a session, so the cost is paid
 * only where the feature is used.
 */
class PageControls {
  private cdp: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | undefined;
  private routing = false;
  /**
   * The settings version last pushed to this page.
   *
   * `applyControls` runs on every page the runtime hands out, which is a hot
   * path: a program that lists pages would otherwise re-send three emulation
   * commands per page per call. The version is bumped only when a setting
   * actually changes, so the common case is a comparison rather than a round
   * trip. -1 means nothing has been applied yet, which is what makes the first
   * application happen even when the version is 0.
   */
  appliedVersion = -1;

  /**
   * The desktop viewport to come back to when mobile emulation is switched off.
   *
   * Remembered because turning the phone off has to restore *something*, and
   * guessing a size would silently resize a thread's page. Undefined means the
   * default is used.
   */
  lastDesktopViewport: { width: number; height: number } | undefined;

  constructor(private readonly page: Page, private readonly context: BrowserContext) {}

  private async session(): Promise<Awaited<ReturnType<BrowserContext["newCDPSession"]>>> {
    if (!this.cdp) this.cdp = await this.context.newCDPSession(this.page);
    return this.cdp;
  }

  /**
   * Install the single request handler that reads the live settings.
   *
   * One handler for the page's whole life, consulting the settings object on
   * every request, rather than re-registering routes on each change. Re-routing
   * would mean unregistering the previous handler, and `unroute` with the wrong
   * reference silently leaves the old one installed.
   */
  async installRouting(getSettings: () => BrowserSettings): Promise<void> {
    if (this.routing) return;
    this.routing = true;
    await this.page.route("**/*", (route) => {
      if (shouldBlockRequest({ url: route.request().url(), resourceType: route.request().resourceType() }, getSettings())) {
        return route.abort().catch(() => undefined);
      }
      return route.continue().catch(() => undefined);
    });
  }

  async setUserAgent(userAgent: string): Promise<void> {
    const cdp = await this.session();
    /*
     * `acceptLanguage` and `platform` are left unset so Chrome keeps reporting
     * its own. Overriding only the UA string and leaving the client hints that
     * contradict it is the shape that gets a bot flagged.
     */
    await cdp.send("Emulation.setUserAgentOverride", { userAgent });
  }

  async setTimezone(timezoneId: string): Promise<void> {
    const cdp = await this.session();
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId });
  }

  async setViewport(width: number, height: number): Promise<void> {
    /*
     * CDP rather than `page.setViewportSize`, because the metrics override is
     * what Steel's own `applyDeviceMetricsOverride` uses, so both agree about
     * the page's size instead of one fighting the other.
     */
    const cdp = await this.session();
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Fullscreen is the window's own size, which is a metrics override to the screen. */
  async setFullscreen(on: boolean): Promise<void> {
    if (!on) return;
    const cdp = await this.session();
    const metrics = await cdp.send("Browser.getWindowBounds", { windowId: 1 }).catch(() => undefined);
    const screen = (metrics as { bounds?: { width?: number; height?: number } } | undefined)?.bounds;
    await this.setViewport(screen?.width ?? 1920, screen?.height ?? 1080);
  }

  /**
   * Present as a phone, or as a desktop again.
   *
   * Three commands, because a phone is three things to a page: the user agent
   * string, the viewport with `mobile: true` (which is what makes a site use its
   * mobile layout rather than a narrow desktop one), and touch support, without
   * which a site that checks for it serves the desktop page anyway. Verified
   * live: the UA, `maxTouchPoints` and viewport all changed.
   */
  async setMobile(on: boolean): Promise<void> {
    const cdp = await this.session();
    if (on) {
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: MOBILE_USER_AGENT, platform: MOBILE_PLATFORM });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: MOBILE_VIEWPORT.width,
        height: MOBILE_VIEWPORT.height,
        deviceScaleFactor: 3,
        mobile: true,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    } else {
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: (this.lastDesktopViewport ?? DEFAULT_VIEWPORT).width,
        height: (this.lastDesktopViewport ?? DEFAULT_VIEWPORT).height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  }

  async detach(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = undefined;
    await cdp?.detach().catch(() => undefined);
  }
}

/**
 * Apply settings to one page and keep applying them as the page changes.
 *
 * Returns a function that re-applies the current settings, which the runtime
 * calls when the settings change and after a navigation replaces the document.
 * The page is held weakly by the caller's map, not here, so a closed page does
 * not keep its controls alive.
 */
export async function applySettingsToPage(
  page: Page,
  context: BrowserContext,
  getSettings: () => BrowserSettings,
  controls: PageControls | undefined,
  settingsVersion: number,
): Promise<PageControls> {
  const owned = controls ?? new PageControls(page, context);
  if (page.isClosed()) return owned;
  const settings = getSettings();
  await owned.installRouting(getSettings);
  /*
   * The routing handler is always installed, because it reads the live settings
   * on every request and so never needs reinstalling. The emulation commands are
   * what cost round trips, and they are skipped when this page already has the
   * current version.
   */
  if (owned.appliedVersion === settingsVersion) return owned;
  /*
   * Mobile wins over a user agent and a viewport, because it sets both: a phone
   * is a UA, a viewport and touch together, and applying a desktop UA on top of
   * it would leave a page that reports iPhone in a desktop layout. A program
   * that sets `mobile: true` and then `userAgent` explicitly still gets its UA,
   * because the patch is applied in order and the explicit one comes last.
   */
  if (settings.viewport) owned.lastDesktopViewport = settings.viewport;
  if (settings.mobile === true) {
    await owned.setMobile(true);
  } else if (settings.mobile === false) {
    await owned.setMobile(false);
  }
  if (settings.userAgent !== undefined && settings.mobile !== true) await owned.setUserAgent(settings.userAgent);
  if (settings.timezone !== undefined) await owned.setTimezone(settings.timezone);
  /*
   * Fullscreen wins over an explicit viewport when both are set, because it is
   * the more recent statement of intent: a program that resized the window and
   * then asked for fullscreen wants fullscreen.
   */
  if (settings.mobile === true) {
    /* The phone's own metrics are already applied above. */
  } else if (settings.fullscreen === true) await owned.setFullscreen(true);
  else if (settings.viewport) await owned.setViewport(settings.viewport.width, settings.viewport.height);
  owned.appliedVersion = settingsVersion;
  return owned;
}

export type { PageControls };
