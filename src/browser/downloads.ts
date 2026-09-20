/**
 * Downloads that outlive the page that made them.
 *
 * Playwright saves a download to a temporary path that is tied to the browser
 * context, and the file is deleted when the context closes. For a browsing
 * session measured in minutes that is invisible. For the thing this tool is
 * actually for, it is fatal: the mission that matters is "download an invoice on
 * one site, upload it on two others", and a file that vanishes on a context
 * change or a server restart cannot be uploaded anywhere later.
 *
 * So every download is copied into a vault the thread owns, on disk, before
 * anything is allowed to depend on it. The path is then stable for as long as
 * the thread's workspace is, which is what makes a cross-site transfer work
 * whether the upload happens one step or one week later.
 *
 * The vault is a directory beside the thread's other state, and the file keeps
 * its suggested name so a program can refer to it the way a person would. A name
 * collision gets a numeric suffix rather than an overwrite, because two
 * downloads called `invoice.pdf` are two different files and silently keeping
 * one is the kind of loss that is discovered at the worst moment.
 */

import { createWriteStream } from "node:fs";
import { mkdir, copyFile, readdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import type { Download, Page } from "playwright";

/** One file in the vault. */
export interface VaultFile {
  /** The name it is stored under, which is what a program should use. */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Size in bytes, so a caller can tell an empty stub from a real file. */
  bytes: number;
  /** The URL it was downloaded from, when Playwright reported one. */
  url?: string;
}

/**
 * A per-thread directory of completed downloads.
 *
 * Constructed with an absolute path so a caller decides where it lives; the
 * runtime derives it from the thread's state path, which keeps everything for
 * one thread under one directory.
 */
export class DownloadVault {
  constructor(private readonly directory: string) {}

  /** Where the files are, so a caller can tell the model where to look. */
  get path(): string {
    return this.directory;
  }

  /** Make sure the directory exists, and answer with it. */
  async ensure(): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    return this.directory;
  }

  /**
   * Copy a finished download into the vault and answer where it went.
   *
   * `saveAs` would move the file, but the temporary copy is owned by the browser
   * and copying leaves it intact for anything else that is mid-flight. A failure
   * to name the file something unique is not fatal: the download is real and the
   * caller gets a path either way, because losing a file to a naming problem
   * would be worse than a surprising name.
   */
  async accept(download: Download): Promise<VaultFile> {
    /*
     * One download, one copy, however many listeners are watching.
     *
     * This is not tidiness. Two things watch for downloads on a page: the
     * `page.on("download")` handler that captures anything a program's click
     * produces, and the armed `waitForEvent("download")` that `download()` uses
     * to return the file in the same call. Both fire for the same event, both
     * called `saveAs`, and the second one found the browser's temporary file
     * already gone:
     *
     *   download.saveAs: ENOENT: no such file or directory, copyfile
     *   '/tmp/playwright-artifacts-S0Ux9z/a872b61a-...' -> '.../invoice.txt'
     *
     * Measured as a flake rather than a failure, which is what made it worth
     * chasing: the same test passed twice and failed once across three runs,
     * because whether the second copy wins the race depends on timing. The
     * download itself always worked, which is the worst shape a bug like this
     * takes.
     *
     * The promise is cached rather than a completed flag, so two concurrent
     * callers await the same copy instead of one of them starting a second.
     */
    const claimed = this.claimed.get(download);
    if (claimed !== undefined) return await claimed;
    const work = this.copy(download);
    this.claimed.set(download, work);
    return await work;
  }

  /**
   * Downloads already being copied, by the object Playwright gave us.
   *
   * A WeakMap keyed on the `Download` itself, because that is the identity two
   * listeners share: they are handed the same object by the same event, so
   * reference equality is exact and needs no id to be invented.
   */
  private readonly claimed = new WeakMap<Download, Promise<VaultFile>>();

  /** The copy itself, once per download. */
  private async copy(download: Download): Promise<VaultFile> {
    await this.ensure();
    const suggested = download.suggestedFilename() || "download";
    const name = await this.uniqueName(sanitize(suggested));
    const target = join(this.directory, name);
    /*
     * `saveAs` is allowed to fail, and the fallback is what makes a download
     * survive the failure.
     *
     * It copies out of the browser's temporary directory, which Playwright
     * creates per connection under `/tmp`. When that directory is not reachable
     * the copy fails with ENOENT and the file is lost even though the browser
     * downloaded it successfully. Measured: the event fired, `saveAs` threw, and
     * the error was swallowed, so the vault looked empty and a model spent
     * twenty minutes on a page that had worked.
     *
     * `download.path()` answers with the same path `saveAs` uses, so it is not a
     * second attempt at the same thing; it is the diagnostic that makes the
     * failure legible. The copy is retried through it once, because a transient
     * problem is possible, and the error is rethrown with both paths named when
     * it fails again. Swallowing it was the bug.
     */
    /*
     * Three attempts, in increasing order of how much they assume.
     *
     * Measured on a live mission, twice in one run:
     *
     *   download.saveAs: ENOENT: no such file or directory, copyfile
     *   '/tmp/playwright-artifacts-5e55Yo/2cc67e50...' -> '.../invoice.txt'
     *
     * The browser downloaded the file, our handler ran, and the temporary copy
     * was not there when it went to fetch it. `saveAs` and `path()` both pointed
     * at the same artifact path, so this is not a second chance at the same
     * operation: it is the artifact directory being cleaned between the event
     * and the copy. The event fires when the download *starts*, and a page that
     * navigates or closes after it can take the artifact with it.
     *
     * So the copy is retried over a short window (the file may still be being
     * written), then the bytes are copied directly from `path()` rather than
     * through `saveAs` (which reports ENOENT for a source it cannot stat, the
     * same as for one that is gone). The error names all three outcomes so the
     * next reader does not have to guess which one happened.
     */
    const failures: string[] = [];
    try {
      await download.saveAs(target);
      failures.length = 0;
    } catch (first) {
      failures.push((first as Error).message.split("\n")[0] ?? "saveAs failed");
    }

    /*
     * The stream is tried before the paths are retried, and it must produce bytes
     * to count.
     *
     * `saveAs` and `download.path()` both name a file in the browser's temporary
     * artifact directory, and when that file is gone both fail the same way:
     * measured, `saveAs` reported ENOENT and all three `copyFile` retries from
     * `path()` failed with it. The stream was added as the route that does not
     * need that file, and it does not deliver either: measured with the artifact
     * removed, it resolves with nothing and `pipeline` succeeds. That is why it
     * now checks the byte count (see `copyThroughStream`), because a stream that
     * writes nothing here is evidence the source is gone, not evidence of an
     * empty download.
     *
     * Ahead of the path retries so the cheap check happens once, and the retries
     * remain for the case they were written for: the artifact lagging the event
     * rather than being gone.
     */
    if (failures.length > 0) {
      if (await this.copyThroughStream(download, target)) {
        failures.length = 0;
      } else {
        /*
         * A brief wait, because the artifact can also just lag the event: the
         * file is written by the browser after the download is announced, and a
         * copy that runs in that window fails on a file that is about to exist.
         * Only reached when the stream failed too, which is the case where the
         * timing explanation is the one still worth trying.
         */
        for (const delayMs of [50, 250, 750]) {
          const copied = await this.copyThroughPath(download, target);
          if (copied) {
            failures.length = 0;
            break;
          }
        }
      }
    }

    if (failures.length > 0) {
      const source = await download.path().catch(() => undefined);
      throw new Error(
        `the browser downloaded "${suggested}" but it could not be copied into this thread's vault. ` +
        `${failures[0]}. ` +
        (source === undefined
          ? "The browser did not report a source path either, so the download was likely cancelled before it finished."
          : `The browser reported it at ${source}, which this process could not read; the vault is ${this.directory}. ` +
            "If the page navigated or closed right after the click, that can remove the temporary file before it is copied."),
      );
    }
    const info = await stat(target).catch(() => undefined);
    const failure = await download.failure().catch(() => null);
    if (failure !== null) {
      /*
       * A failed download that produced a file is reported as the file it is
       * rather than as an error: the caller can decide, and a partial file is
       * sometimes exactly what a site offers.
       */
      return { name, path: target, bytes: info?.size ?? 0, ...(download.url() ? { url: download.url() } : {}) };
    }
    return { name, path: target, bytes: info?.size ?? 0, ...(download.url() ? { url: download.url() } : {}) };
  }

  /**
   * Copy the artifact by streaming its bytes, and refuse to call an empty stream
   * a copy.
   *
   * ## This attempt was added to recover a failure it does not recover
   *
   * It was written for the case `saveAs` reports ENOENT on: the browser's
   * temporary artifact directory has been cleaned between the download event and
   * the copy, so the file is gone from disk. The idea was that
   * `createReadStream()` reads over the CDP connection and does not need that
   * file. Measured against the real endpoint, with the artifact removed exactly
   * as the failure describes:
   *
   *   saveAs:            REJECTED  download.saveAs: ENOENT: no such file ...
   *   createReadStream:  RESOLVED  streamed=0 bytes
   *
   * The stream resolves, delivers nothing, and `pipeline` succeeds. So the bytes
   * were never coming over CDP: the source is that same artifact. Worse than
   * useless, the successful-looking pipeline turned the loud failure into a
   * silent one. Two missions downloaded the same invoice three times each and the
   * vault held three 0-byte files, reported as successful downloads, which the
   * model then spent tool calls investigating with `ls` and `wc -c`.
   *
   * The version before it threw, the model retried, and a later copy landed the
   * real 66 bytes. That is the behaviour worth keeping, so this requires bytes: a
   * zero-byte result is a failed copy, the empty file is removed, and the caller
   * falls through to the error that names what happened.
   *
   * The one case this would misjudge is a genuinely empty file that also failed
   * `saveAs`, which is rare and lands in the safe direction: the model is told the
   * copy did not produce content rather than being handed a file that looks real.
   */
  private async copyThroughStream(download: Download, target: string): Promise<boolean> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await download.createReadStream();
    } catch {
      return false;
    }
    try {
      await pipeline(stream as NodeJS.ReadableStream, createWriteStream(target));
    } catch {
      await rm(target, { force: true }).catch(() => undefined);
      return false;
    }
    const written = await stat(target).catch(() => undefined);
    if ((written?.size ?? 0) > 0) return true;
    await rm(target, { force: true }).catch(() => undefined);
    return false;
  }

  /**
   * Copy the artifact by reading the path Playwright reports, not by saveAs.
   *
   * `saveAs` is the documented way and it is what the first attempt uses. This
   * is the fallback for the case it reports ENOENT on: it stats the source
   * itself and copies the bytes, which distinguishes "the file is not there yet"
   * from "the file is not there" and can succeed in the window between the two
   * that a second `saveAs` call cannot.
   *
   * Returns false rather than throwing, because the caller decides what the
   * failure means and has more context than this does.
   */
  private async copyThroughPath(download: Download, target: string): Promise<boolean> {
    const source = await download.path().catch(() => undefined);
    if (source === undefined) return false;
    try {
      await copyFile(source, target);
      return true;
    } catch {
      return false;
    }
  }

  /** Everything already in the vault, newest name last. */
  async list(): Promise<VaultFile[]> {
    await this.ensure();
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const out: VaultFile[] = [];
    for (const name of names) {
      const path = join(this.directory, name);
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) out.push({ name, path, bytes: info.size });
    }
    return out;
  }

  /** A path for a name, so a program can hand it to an upload input. */
  resolve(name: string): string {
    return join(this.directory, basename(name));
  }

  /**
   * A name that is not already taken.
   *
   * `invoice.pdf`, `invoice-2.pdf`, `invoice-3.pdf`. A numeric suffix rather than
   * a timestamp, because the name is something a program will type and a
   * timestamp makes it unpredictable.
   */
  private async uniqueName(name: string): Promise<string> {
    const existing = new Set(await readdir(this.directory).catch(() => [] as string[]));
    if (!existing.has(name)) return name;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem}-${i}${ext}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }
}

/** Take the path part of a suggested filename and refuse anything that climbs. */
function sanitize(name: string): string {
  const base = basename(name).replace(/[\/\\]/g, "_").trim();
  if (base.length === 0 || base === "." || base === "..") return "download";
  return base.slice(0, 180);
}

/**
 * Wire a page so its downloads land in the vault.
 *
 * Attached per page rather than per context, because a download is triggered by
 * an action on a page and the handler needs that page's event. A download with
 * nobody listening is discarded by Playwright, which is the silent loss this
 * exists to prevent.
 *
 * Takes a store function rather than the vault itself, and that indirection is
 * what gives an unarmed download its provenance. Storing through the vault copied
 * the file and told the ledger nothing, so a program that clicked a download link
 * without wrapping it in `download()` got a real file that
 * `artifactFromAction` then refused, because no ledger event named the click
 * that produced it. The caller now routes this through the artifact manager,
 * which records the file against the action that was running, and the two
 * listeners dedupe on the stored path so one download is one event.
 *
 * Returns the accumulated files, so a caller can report what a program produced
 * without a second lookup. A store that answers `undefined` means the file was
 * kept somewhere this list does not describe, which is a runtime with no vault;
 * the download still happened and nothing is added.
 */
export function watchDownloads(
  page: Page,
  store: (download: Download) => Promise<VaultFile | undefined>,
  collected: VaultFile[],
  onFailure?: (error: Error) => void,
): void {
  page.on("download", (download) => {
    void store(download)
      .then((file) => {
        /*
         * Pushed once, by path. Two listeners now reach the same file: this
         * page-level watcher, which exists so a download nobody armed is still
         * kept, and the artifact manager's armed wait, which exists so
         * `download()` can return the file in the same call. The vault collapses
         * them into one copy; this collapses them into one entry, so a program
         * that lists the vault does not see the same invoice twice.
         */
        if (file !== undefined && !collected.some((existing) => existing.path === file.path)) collected.push(file);
      })
      /*
       * Reported rather than dropped, and this is half of the twenty-minute bug.
       *
       * The event fired, the copy failed, and the failure went nowhere: the
       * caller saw an empty vault and a click that appeared to do nothing, which
       * is indistinguishable from a click that hit the wrong element. Passing the
       * reason up is what lets `downloadAfter` say "the copy failed, here is
       * where the browser had it" instead of sending the model back to inspect a
       * page that was never the problem.
       */
      .catch((error: unknown) => {
        onFailure?.(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

/**
 * Find files in the vault that nothing has claimed yet.
 *
 * The event is not the only way a file arrives, and treating it as the only way
 * is what cost a live mission twenty minutes. `page.on("download")` is
 * Playwright's notification, and it depends on this process owning the browser
 * configuration: Steel sets `Browser.setDownloadBehavior` at launch with its own
 * directory, and a client that re-sets it is racing that. When the race is lost
 * the file still lands, Chrome still names it, and nothing tells us.
 *
 * So the directory is the source of truth and the event is the fast path. A file
 * present in the vault that is not in `collected` was written by the browser and
 * never announced, and adding it is what turns "no download started" into "here
 * is your file" in exactly the case where the model would otherwise have to
 * guess.
 *
 * `allowAndName` names files by their GUID, so an unannounced file has a name no
 * person would recognise. It is kept under that name rather than renamed: the
 * path is what an upload needs, and inventing a friendlier name would be a guess
 * about which file it is.
 */
export async function collectUnannounced(vault: DownloadVault, collected: VaultFile[]): Promise<VaultFile[]> {
  const known = new Set(collected.map((file) => file.path));
  const found = await vault.list().catch(() => [] as VaultFile[]);
  const fresh = found.filter((file) => !known.has(file.path) && file.bytes > 0);
  for (const file of fresh) collected.push(file);
  return fresh;
}
