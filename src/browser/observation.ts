/**
 * The observation boundary: one interface, one implementation today.
 *
 * Everything above this line in the browser layer (the IR compiler, identity,
 * relevance, the model's view) is written against `CollectedPage`, a plain data
 * structure. Everything below it reads a live page. This interface is the seam
 * between them.
 *
 * It exists because a second collector is plausibly worth adding later, and
 * because the cost of the seam now is one file while the cost of discovering it
 * is missing later is a rewrite. It is deliberately narrow: the only thing a
 * provider does is turn a page into a `CollectedPage`, with no opinion about
 * sections, identity, relevance or what the model is shown.
 *
 * What is deliberately NOT abstracted: the page itself. Playwright owns
 * execution and that is settled; a provider that wanted to drive the browser
 * would be a second controller, and two controllers on one page is the one thing
 * the architecture refuses. A provider observes.
 *
 * The second implementation this is for, when the 100-site sweep says our
 * collector is failing on some class of site, is a sidecar running browser-use's
 * DomService over the same CDP endpoint. It is not built now because the
 * evidence for or against it is the sweep, and building it first would mean
 * maintaining two collectors against a bug list we do not have yet.
 */

import type { Page } from "playwright";

import { collectPage, type CollectedPage } from "./collect.js";

export interface ObservationRequest {
  /** The page to read. Owned by the caller; the provider never navigates. */
  page: Page;
  /**
   * How long to wait for the page to settle before reading it.
   *
   * A provider is free to ignore this, and the reason it is a hint rather than a
   * contract is that a correct provider reads whatever state the page is in and
   * reports what it found. A provider that refused to read an unsettled page
   * would be worse than one that read it and said so.
   */
  settleMs?: number | undefined;
}

export interface ObservationProvider {
  /** A name for the journal and for `why()`, so a reading can be attributed. */
  readonly name: string;
  observe(request: ObservationRequest): Promise<CollectedPage>;
}

/**
 * The collector that ships today.
 *
 * Everything in `collect.ts` is behind this, which is what makes the seam real
 * rather than decorative: swapping in a sidecar means writing one more object
 * with an `observe` method and changing which one is constructed, with no
 * change to the compiler, the identity layer, or the model's view.
 */
export const nativeObservationProvider: ObservationProvider = {
  name: "native-cdp",
  observe: async ({ page }: ObservationRequest): Promise<CollectedPage> => collectPage(page),
};
