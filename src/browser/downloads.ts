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

import { mkdir, copyFile, readdir, stat } from "node:fs/promises";
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
    try {
      await download.saveAs(target);
    } catch (first) {
      const source = await download.path().catch(() => undefined);
      const retry = source === undefined ? undefined : await download.saveAs(target).then(() => true, () => false);
      if (retry !== true) {
        throw new Error(
          `the browser downloaded "${suggested}" but it could not be copied into this thread's vault. ` +
          `${(first as Error).message.split("\n")[0]}. ` +
          (source === undefined
            ? "The browser did not report a source path either."
            : `The browser had it at ${source}, which this process could not read; the vault is ${this.directory}.`),
        );
      }
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
 * Returns the accumulated files, so a caller can report what a program produced
 * without a second lookup.
 */
export function watchDownloads(
  page: Page,
  vault: DownloadVault,
  collected: VaultFile[],
  onFailure?: (error: Error) => void,
): void {
  page.on("download", (download) => {
    void vault
      .accept(download)
      .then((file) => { collected.push(file); })
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
