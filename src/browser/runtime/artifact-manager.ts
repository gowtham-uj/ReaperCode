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
  /**
   * The wall-clock instant the wait was armed, checked against each file's
   * mtime.
   *
   * This is the staleness floor, and `Date.now()` rather than `performance.now()`
   * on purpose: the comparison is against an mtime from the filesystem, so the
   * two have to be the same kind of clock. A monotonic timestamp would make every
   * file look old and silently remove the fallback this exists to provide.
   *
   * The arm is the right floor rather than the runtime's construction, because
   * `known` already covers everything the vault held at that moment and the
   * question here is only about what appeared afterwards. A file older than the
   * trigger cannot have been caused by it.
   */
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
    const record: Armed = { page, pending, known, armedAt: Date.now() };
    /*
     * The rejection is absorbed here, not recorded. A wait nobody collects would
     * otherwise raise an unhandled rejection, which node turns into a warning
     * that names neither the page nor the download; there is nothing else to do
     * with it, because `collect` is where the outcome is read and it awaits the
     * same promise itself.
     */
    pending.catch(() => undefined);
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
   *
   * Answering `undefined` is a real outcome, not a failure: the caller reports
   * that no download arrived and the ledger records nothing, which is what a
   * click that produced no file should say.
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

    if (announced === undefined) {
      /*
       * No event. The vault decides, and only a file this arm can have caused
       * counts.
       *
       * The runtime is in a position to know that without Playwright's
       * notification: it recorded what the vault held before the trigger ran and
       * what it holds after. A dropped event is a fact about the CDP race, not
       * about whether the download happened, and treating the two as one made a
       * real download look like a file that happened to be lying around.
       *
       * The old version took the last entry of the directory with no filter and
       * no sort, so a wait whose event never fired, including one that timed
       * out, answered with whatever the thread had downloaded last. Measured: a
       * page whose `waitForEvent("download")` rejected still produced an
       * artifact with `triggeredBy` set, so `artifactFromAction` passed for a
       * click that downloaded nothing.
       *
       * A file that clears those checks is not in `known` by construction, so it
       * is a file this arm did not see before the trigger ran, and the ledger
       * records it against the action the way the dropped-event race requires.
       * The alternative, marking a file found by listing the directory as
       * unannounced, was rejected: `announced` is what the ledger and
       * `artifactFromAction` read to mean "this action caused this file", and
       * clearing it would turn a real download whose event was lost into an
       * unattributed one, which is the measured flake `Armed.known` exists to
       * stop. What has to be excluded is a file from outside this arm's window,
       * and that is what the filter above does.
       */
      const found = await this.newestUnclaimed(record);
      if (found === undefined) return undefined;
      /*
       * `true`, and the reason is not obvious from here.
       *
       * This used to be `!record.known.has(found.path)`, which was a tautology:
       * `newestUnclaimed` already excludes everything in `known`, so the test
       * could only ever be true. It read as a check and was not one. What
       * actually keeps the file attributable is the mtime floor in
       * `newestUnclaimed`, which is what the comment above describes.
       */
      return await this.finish(found, true, options);
    }

    const stored = await this.vault.accept(announced);
    return await this.finish(stored, true, options);
  }

  /** Store a download that arrived on the page's own listener, not through an arm. */
  async adopt(page: Page, download: Download, actionId?: string): Promise<Artifact> {
    const stored = await this.vault.accept(download);
    /*
     * Adopted downloads count as announced: Playwright raised the event, this
     * just picked it up from a different listener. The distinction the ledger
     * cares about is event-versus-file, not which code path noticed.
     */
    void page;
    return await this.finish(stored, true, actionId !== undefined ? { actionId } : {});
  }

  /** Hash what was stored, record it, and answer with the whole artifact. */
  private async finish(file: VaultFile, announced: boolean, options: CollectOptions): Promise<Artifact> {
    const sha256 = await hashOf(file.path).catch(() => "");
    const artifact: Artifact = { ...file, sha256, announced };
    /*
     * One file, one ledger event, however many listeners reach it.
     *
     * Two code paths call this for the same download: the armed collector that
     * `download()` uses, and the page-level watcher that keeps a download nobody
     * armed. They are different listeners on the same event, so both fire, and
     * without this both recorded `artifact.saved` for one file. The consequence
     * was not a crash but a wrong number: the metrics counted two downloads where
     * a program made one, and a benchmark reading them would over-report.
     *
     * Keyed on the stored path, which the vault has already made unique, so two
     * genuine downloads of `invoice.pdf` are two events and one download seen
     * twice is one.
     */
    if (!this.recorded.has(artifact.path)) {
      this.recorded.add(artifact.path);
      this.ledger?.record({
        kind: "artifact.saved",
        name: artifact.name,
        path: artifact.path,
        bytes: artifact.bytes,
        announced,
        ...(options.actionId !== undefined ? { triggeredBy: options.actionId } : {}),
      });
    }
    return artifact;
  }

  /** Paths already recorded, so a second listener does not double-count a file. */
  private readonly recorded = new Set<string>();

  /**
   * A file in the vault that this arm can have caused, if the vault holds
   * exactly one.
   *
   * A file counts only when it landed after the wait was armed, is not empty,
   * and is not one the arm already saw and recorded in `known`.
   *
   * Exactly one, and that limit is the point. With two candidates there is no
   * fact in this process that says which the trigger caused, and guessing would
   * put the wrong file, or a file from an earlier click, into the ledger under
   * this action's name. Answering `undefined` sends the caller to "no download
   * arrived", which is honest about what is known and is what a receipt should
   * say rather than naming a file that may belong to something else.
   *
   * The consequence for two arms outstanding at once is worth stating because an
   * earlier version of this comment claimed the opposite. Two arms, two files:
   * each arm's candidate set is both files, so both answer `undefined`. This is
   * not a regression against the version that took the last file unconditionally
   * (that was the bug), but it is a real behaviour and it is not "the first takes
   * the earliest and the second takes the next". The program-side `download()`
   * helper arms, triggers and collects strictly in sequence, so reaching it needs
   * a program holding two arms at once.
   *
   * The mtime comparison is a strict `>` against a wall-clock arm time, so on a
   * filesystem with one-second mtime granularity a file copied in the same
   * second as the arm compares equal and is refused. That is the safe direction:
   * it reports "no download arrived" rather than naming a file that may be
   * earlier. The vaults here are on tmpfs and ext4, where the granularity is
   * nanoseconds, so it does not bite in practice.
   */
  private async newestUnclaimed(record: Armed): Promise<VaultFile | undefined> {
    const files = await this.vault.list().catch(() => [] as VaultFile[]);
    const candidates = files
      .filter((file) => file.bytes > 0 && file.mtimeMs > record.armedAt && !record.known.has(file.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    if (candidates.length !== 1) return undefined;
    return candidates[0];
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
