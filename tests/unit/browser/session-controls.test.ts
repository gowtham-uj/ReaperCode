/**
 * The rules behind the agent-controllable browser settings.
 *
 * The interesting cases are all boundaries: a host that merely ends with the
 * same letters as an ad network, a subdomain that really is one, a block list
 * with a port on it, and a UA pool that must not hand back the string it was
 * just told to abandon.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isAdRequest, shouldBlockRequest } from "../../../src/browser/session-controls.js";
import { defaultUserAgent, knownUserAgents, looksBlocked, nextUserAgent } from "../../../src/browser/user-agents.js";

test("ad hosts match exactly and by subdomain, but not by suffix accident", () => {
  assert.equal(isAdRequest("https://doubleclick.net/pixel"), true);
  assert.equal(isAdRequest("https://ad.doubleclick.net/pixel"), true);
  assert.equal(isAdRequest("https://www.googlesyndication.com/x"), true);
  // A host that merely ends with the same letters is not the ad network. This is
  // the case a naive `includes` gets wrong.
  assert.equal(isAdRequest("https://notdoubleclick.net/x"), false);
  assert.equal(isAdRequest("https://mycriteo.com.evil.example/x"), false);
  // An ordinary site is untouched.
  assert.equal(isAdRequest("https://example.com/"), false);
  assert.equal(isAdRequest("not a url"), false);
});

test("bandwidth settings refuse only the kinds they name", () => {
  const images = { url: "https://example.com/a.png", resourceType: "image" };
  const media = { url: "https://example.com/a.mp4", resourceType: "media" };
  const doc = { url: "https://example.com/", resourceType: "document" };
  const css = { url: "https://example.com/a.css", resourceType: "stylesheet" };

  assert.equal(shouldBlockRequest(images, { bandwidth: { blockImages: true } }), true);
  assert.equal(shouldBlockRequest(media, { bandwidth: { blockImages: true } }), false);
  assert.equal(shouldBlockRequest(media, { bandwidth: { blockMedia: true } }), true);
  assert.equal(shouldBlockRequest(css, { bandwidth: { blockStylesheets: true } }), true);
  // The document is never blocked: refusing it would leave nothing to read.
  assert.equal(shouldBlockRequest(doc, { bandwidth: { blockImages: true, blockMedia: true, blockStylesheets: true } }), false);
  // No settings means nothing is blocked.
  assert.equal(shouldBlockRequest(images, {}), false);
});

test("explicit hosts and url patterns are honoured", () => {
  const req = { url: "https://tracker.example.com/beacon", resourceType: "xhr" };
  assert.equal(shouldBlockRequest(req, { bandwidth: { blockHosts: ["tracker.example.com"] } }), true);
  assert.equal(shouldBlockRequest(req, { bandwidth: { blockHosts: ["other.example.com"] } }), false);
  assert.equal(shouldBlockRequest(req, { bandwidth: { blockUrlPatterns: ["/beacon"] } }), true);
  assert.equal(shouldBlockRequest(req, { bandwidth: { blockUrlPatterns: ["/nothing"] } }), false);
});

test("ad blocking is opt-in and composes with bandwidth settings", () => {
  const ad = { url: "https://doubleclick.net/pixel", resourceType: "image" };
  assert.equal(shouldBlockRequest(ad, {}), false, "ads are not blocked unless asked");
  assert.equal(shouldBlockRequest(ad, { blockAds: true }), true);
  assert.equal(shouldBlockRequest(ad, { blockAds: false }), false);
});

test("the user agent pool is real Chrome and never repeats itself on rotation", () => {
  const pool = knownUserAgents();
  assert.ok(pool.length >= 2, "rotation needs somewhere to go");
  for (const ua of pool) {
    assert.match(ua, /Chrome\/\d+/, `${ua} should name a Chrome version`);
    assert.doesNotMatch(ua, /Headless/i, "a stealth pool must not advertise headless");
  }
  // Rotation must move off the current string, which is the whole point.
  let current = defaultUserAgent();
  for (let i = 0; i < pool.length; i++) {
    const next = nextUserAgent(current);
    assert.notEqual(next, current, "rotation must produce a different user agent");
    current = next;
  }
  // An unknown starting point lands on a known one rather than undefined.
  assert.ok(pool.includes(nextUserAgent("something-else")));
});

test("block detection recognises real block pages and ignores ordinary ones", () => {
  assert.equal(looksBlocked({ status: 403 }).blocked, true);
  assert.equal(looksBlocked({ status: 429 }).blocked, true);
  assert.equal(looksBlocked({ title: "Just a moment..." , bodyText: "Checking your browser before accessing"}).blocked, true);
  assert.equal(looksBlocked({ bodyText: "Our systems have detected unusual traffic from your computer network" }).blocked, true);
  assert.equal(looksBlocked({ bodyText: "Please verify you are human" }).blocked, true);
  assert.equal(looksBlocked({ title: "Access Denied" }).blocked, true);

  // Ordinary pages must not trip it. A false positive rotates the user agent on
  // a page that was working, which is worse than missing a block.
  assert.equal(looksBlocked({ status: 200, title: "Example Domain", bodyText: "This domain is for use in examples." }).blocked, false);
  assert.equal(looksBlocked({ title: "Hacker News", bodyText: "Hacker News new | past | comments" }).blocked, false);
  assert.equal(looksBlocked({}).blocked, false);
});
