/**
 * The user agents a browsing thread presents, and how they change.
 *
 * A browsing agent that announces itself as automation gets served the
 * automation experience: interstitials, throttled pages, and outright refusals.
 * So the default is a real browser's user agent string, and when a site refuses
 * one the answer is to try another rather than to retry the same request.
 *
 * The pool is deliberately small and hand-checked. A large generated pool looks
 * better and is worse: a UA that does not match the client hints Chrome sends
 * alongside it is the single most reliable automation signal there is, and the
 * only defence against that is not to claim a browser this Chrome is not. So
 * every entry here is a recent desktop Chrome on a plausible platform, which is
 * what the underlying browser actually is.
 *
 * Rotation is per thread and only on an explicit signal (see `looksBlocked`).
 * Rotating on a hunch would break a site that was working, and a site that
 * serves a captcha to one request usually serves it to the next string too, so
 * rotation is a mitigation rather than a cure and the caller is told which it
 * was.
 */

/**
 * Desktop Chrome user agents, newest first.
 *
 * Kept to Chrome because that is what Steel runs. Claiming Firefox while
 * `navigator.userAgentData` says Chromium is a contradiction a fingerprinting
 * script reads in one line.
 */
const CHROME_USER_AGENTS: ReadonlyArray<string> = [
  // Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  // macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  // Linux
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
];

/**
 * Pick the next user agent, avoiding the one already in use.
 *
 * Deterministic per call rather than random: a round-robin over the pool means
 * a thread that rotates twice cannot land back on the string it just abandoned,
 * which random selection allows and which looks exactly like a retry loop to the
 * site being retried.
 */
export function nextUserAgent(current: string | undefined): string {
  if (current === undefined) return CHROME_USER_AGENTS[0]!;
  const index = CHROME_USER_AGENTS.indexOf(current);
  if (index === -1) return CHROME_USER_AGENTS[0]!;
  return CHROME_USER_AGENTS[(index + 1) % CHROME_USER_AGENTS.length]!;
}

/** The user agent a thread starts with when it has not chosen one. */
export function defaultUserAgent(): string {
  return CHROME_USER_AGENTS[0]!;
}

/** Every user agent the pool can produce, for tests and for a caller that wants to pin one. */
export function knownUserAgents(): ReadonlyArray<string> {
  return CHROME_USER_AGENTS;
}

/**
 * Whether a page looks like it refused us for being automated.
 *
 * Three signals, and each is one a real block page actually emits:
 *
 *   - an HTTP status of 403 or 429 on the document
 *   - a title or heading naming a block, a captcha, or unusual traffic
 *   - Cloudflare's and PerimeterX's challenge markers, which are distinctive
 *     enough to match on without catching ordinary pages
 *
 * Deliberately conservative. A false positive here rotates the user agent on a
 * page that was fine, which is a worse outcome than missing a block, because a
 * missed block is visible to the model as a broken page while a spurious
 * rotation silently changes what every later request looks like.
 */
export function looksBlocked(input: {
  status?: number | undefined;
  title?: string | undefined;
  bodyText?: string | undefined;
  url?: string | undefined;
}): { blocked: boolean; reason?: string } {
  const status = input.status;
  if (status === 403) return { blocked: true, reason: "the site answered 403 Forbidden" };
  if (status === 429) return { blocked: true, reason: "the site answered 429 Too Many Requests" };

  const haystack = `${input.title ?? ""}\n${input.bodyText ?? ""}`.toLowerCase();
  const markers: ReadonlyArray<[string, string]> = [
    ["unusual traffic", "the page reports unusual traffic"],
    ["are you a robot", "the page asks whether we are a robot"],
    ["verify you are human", "the page asks us to verify we are human"],
    ["checking your browser", "the page is running a browser check"],
    ["enable javascript and cookies to continue", "the page is a challenge screen"],
    ["access denied", "the page says access is denied"],
    ["cf-chl", "the page is a Cloudflare challenge"],
    ["px-captcha", "the page is a PerimeterX challenge"],
    ["captcha-delivery", "the page is a DataDome challenge"],
  ];
  for (const [needle, reason] of markers) {
    if (haystack.includes(needle)) return { blocked: true, reason };
  }
  return { blocked: false };
}
