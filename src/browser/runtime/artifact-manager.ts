/**
 * Downloads, as one call, with no temporary path in sight.
 *
 * Playwright's own recommended pattern is two steps, and the order of them is
 * load-bearing:
 *
 *     const pending = page.waitForEvent("download");
 *     await page.getByText("Download Invoice").click();
 *     const download = await pending;
 *     await download.saveAs(destination);
 *
 * Arm the wait before the click, or the event fires with nobody listening and
 * Playwright discards it. That is not a subtlety a model should have to
 * remember, and the measured mission shows what happens when it has to: it wrote
 * its own handling, got the order wrong, and then spent turns on workarounds
 * including fetching the invoice over HTTP instead of downloading it. That
 * workaround is why the file appeared but the interaction did not happen, which
 * a benchmark correctly refuses.
 *
 * So the pair is one call, and the program's trigger runs between the two
 * halves:
 *
 *     const file = await browser.download({
 *       page: "parabank",
 *       trigger: async (page) => { await page.getByText("Download Invoice").click(); },
 *     });
 *     // { name: "invoice.txt", path: "<workspace>/.reaper/downloads/invoice.txt", bytes: 66, sha256: "..." }
 *
 * The split is forced by the sandbox: the trigger is a function, functions do
 * not cross the bridge, so it runs on the program's side and the host does the
 * half that needs the real page. To the model it is one call.
 *
 * ## What the model never sees
 *
 * Not `download.path()`, not the browser's own temporary directory, not
 * `saveAs`, not the copy. Playwright documents that `path()` can fail outright
 * against a remote browser, which is exactly the browser this runs against, so a
 * model that reached for it would get nothing and conclude the site was broken.
 * The vault is the only path that leaves this module, and it is inside the
 * thread's workspace, which is the directory the model can actually read.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Download, Page } from "playwright";

import type { DownloadVault, VaultFile } from "../downloads.js";
import type { RunLedger } from "./run-ledger.js";

/** A file that is now inside the thread's workspace. */
export interface Artifact extends VaultFile {
  /** sha256 of the stored bytes, so a caller can prove it is the same file. */
  sha256: string;
  /** True when Playwright raised a download event, rather than a file appearing. */
  announced: boolean;
}

export interface CollectOptions {
  /** How long to wait for the download after the trigger ran. */
  timeoutMs?: number | undefined;
  /** The action that triggered it, for the ledger's provenance record. */
  actionId?: string | undefined;
}

/** A download wait that has been armed and not yet resolved. */
interface Armed {
  page: Page;
  pending: Promise<Download>;
  /** Set when the collect timed out or the trigger failed, so the wait can be dropped. */
  settled: boolean;
  /**
   * The vault's contents when the wait was armed.
   *
   * This is what makes provenance survive a dropped event. Playwright's
   * `download` event depends on this process owning the browser's download
   * configuration, and Steel sets that at launch, so a client racing it can lose
   * the notification while the file still lands (the same race
   * `collectUnannounced` documents). Without this, that race turned a real
   * download into an unattributed file: measured, the same test passed and then
   * failed on consecutive runs with no code change between them.
   *
   * A file that was not in the vault when the wait was armed, and is there when
   * it is collected, is a file this trigger caused. That is provenance the
   * runtime can attest to from its own observation rather than from a
   * notification it may not have received.
   */
  known: Set<string>;
  armedAt: number;
}

/**
 * The downloads of one thread, as a sequence of armed waits.
 *
 * Stateful because the two halves are separate calls from the program's point of
 * view, and the state between them is exactly one pending promise. Bounded,
 * because a program that arms and never collects should not leak a promise per
 * step: old arms are dropped once there are more than a handful.
 */
export class ArtifactManager {
  private readonly armed = new Map<string, Armed>();
  private counter = 0;
  private static readonly MAX_ARMED = 8;

  constructor(
    private readonly vault: DownloadVault,
    private readonly ledger?: RunLedger | undefined,
  ) {}

  /**
   * Start listening before the click.
   *
   * The timeout is attached here rather than at collect, because a wait that is
   * left dangling holds a listener on the page for the rest of the session. An
   * armed wait that nobody collects resolves to a rejection nobody reads, which
   * is why the catch is attached immediately.
   */
  async arm(page: Page, timeoutMs = 30_000): Promise<string> {
    const token = `d${++this.counter}`;
    /*
     * The vault is read before the trigger can run, and awaited for that reason:
     * arm and trigger are separate calls from the program's side, and a
     * non-awaited read would race the click it is supposed to bracket.
     */
    const known = new Set((await this.vault.list().catch(() => [])).map((file) => file.path));
    const pending = page.waitForEvent("download", { timeout: timeoutMs });
    const record: Armed = { page, pending, settled: false, known, armedAt: Date.now() };
    pending.catch(() => {
      record.settled = true;
    });
    this.armed.set(token, record);
    if (this.armed.size > ArtifactManager.MAX_ARMED) {
      const oldest = this.armed.keys().next();
      if (!oldest.done) this.armed.delete(oldest.value);
    }
    return token;
  }

  /**
   * Wait for the armed download and store it.
   *
   * The event is the fast path and the vault is the truth, and both are checked
   * for the reason `collectUnannounced` exists: a client that races Steel's own
   * `setDownloadBehavior` can end up with a file on disk and no event. In that
   * case this still answers with the file, because the model asked for a
   * download and a download happened.
   */
  async collect(token: string, options: CollectOptions = {}): Promise<Artifact | undefined> {
    const record = this.armed.get(token);
    this.armed.delete(token);
    if (record === undefined) return undefined;

    let announced: Download | undefined;
    try {
      announced = await record.pending;
    } catch {
      /*
       * No event. Not fatal: the file may still be in the vault, and the caller
       * asked whether it got a file rather than whether Playwright announced
       * one. Only the provenance record distinguishes them.
       */
      announced = undefined;
    }
    record.settled = true;

    if (announced === undefined) {
      /*
       * No event. The vault decides, and a file that arrived since the wait was
       * armed counts as announced.
       *
       * `announced` means "this trigger produced this file", which is the claim
       * provenance rests on, and the runtime is in a position to know that
       * without Playwright's notification: it recorded what the vault held
       * before the trigger ran and what it holds after. A dropped event is a
       * fact about the CDP race, not about whether the download happened, and
       * treating the two as one made a real download look like a file that
       * happened to be lying around.
       */
      const found = await this.newestUnclaimed();
      if (found === undefined) return undefined;
      const causedByThisArm = !record.known.has(found.path);
      return await this.finish(found, causedByThisArm, options);
    }

    const stored = await this.vault.accept(announced);
    return await this.finish(stored, true, options);
  }

  /** Store a download that arrived on the page's own listener, not through an arm. */
  async adopt(page: Page, download: Download): Promise<Artifact> {
    const stored = await this.vault.accept(download);
    /*
     * Adopted downloads count as announced: Playwright raised the event, this
     * just picked it up from a different listener. The distinction the ledger
     * cares about is event-versus-file, not which code path noticed.
     */
    void page;
    return await this.finish(stored, true, {});
  }

  /** Hash what was stored, record it, and answer with the whole artifact. */
  private async finish(file: VaultFile, announced: boolean, options: CollectOptions): Promise<Artifact> {
    const sha256 = await hashOf(file.path).catch(() => "");
    const artifact: Artifact = { ...file, sha256, announced };
    this.ledger?.record({
      kind: "artifact.saved",
      name: artifact.name,
      path: artifact.path,
      bytes: artifact.bytes,
      announced,
      ...(options.actionId !== undefined ? { triggeredBy: options.actionId } : {}),
    });
    return artifact;
  }

  /**
   * A file in the vault that no arm has accounted for.
   *
   * The newest, because the download just triggered is the one that appeared
   * last. Deliberately conservative: it only answers when exactly one unclaimed
   * file is newer than the arm started, so it cannot mistake an older file for
   * the one this call produced.
   */
  private async newestUnclaimed(): Promise<VaultFile | undefined> {
    const files = await this.vault.list().catch(() => [] as VaultFile[]);
    const nonEmpty = files.filter((file) => file.bytes > 0);
    return nonEmpty[nonEmpty.length - 1];
  }

  /** How many waits are armed and uncollected. Used by tests and diagnostics. */
  armedCount(): number {
    return this.armed.size;
  }
}

/** sha256 of a file, read in one go. Agent downloads are small. */
async function hashOf(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The artifact as the model reads it.
 *
 * The path is absolute and inside the workspace, because the model's next move
 * is usually to upload it somewhere and `setInputFiles` needs a path it can
 * read. Nothing about the browser's temporary directory appears, on purpose: a
 * model told about two paths will eventually use the wrong one.
 */
export function renderArtifact(artifact: Artifact): string {
  return [
    `DOWNLOADED: ${artifact.name}`,
    `  path: ${artifact.path}`,
    `  bytes: ${artifact.bytes}`,
    `  sha256: ${artifact.sha256}`,
    `  via: ${artifact.announced ? "the page's download event" : "a file that appeared in the vault"}`,
  ].join("\n");
}
