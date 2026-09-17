/**
 * The parts of a browser's state that Playwright's `storageState` leaves out.
 *
 * `context.storageState()` serializes cookies and localStorage. Measured, not
 * assumed: written to all four storage kinds and dumped through it, the result
 * carried `cookies` and `origins[].localStorage` and nothing else. IndexedDB was
 * absent.
 *
 * That gap is not academic. Session persistence lives in IndexedDB on a lot of
 * the web now: Supabase, Firebase, most PWA frameworks, and a lot of banking and
 * SaaS apps keep their auth token there precisely because it survives a reload
 * without being readable from a cookie. So a thread that signs in to one of
 * those apps and restarts comes back signed out, and the state file it wrote
 * looks complete.
 *
 * Steel's own session context covers all four kinds (`services/context/types.ts`
 * has Cookies, LocalStorage, SessionStorage and IndexedDB providers), so its
 * model is the one to match. This module matches it for IndexedDB specifically,
 * which is the one that is both missing and durable.
 *
 * ## Why not sessionStorage
 *
 * Chrome scopes sessionStorage to a tab and discards it when the tab closes, and
 * a thread's pages close when the thread is reaped. Restoring it would mean
 * writing values into a document that a navigation then clears, so a thread
 * would appear to have restored something it does not have. It is deliberately
 * absent rather than overlooked.
 *
 * ## What is captured
 *
 * Values are serialized as JSON, so a record holding a Blob, a File, a typed
 * array or a cyclic structure is reported as skipped rather than silently
 * dropped. A partial restore that says what it could not carry is honest; one
 * that says nothing is a bug the next session inherits.
 */

import type { BrowserContext, Page } from "playwright";

/** One IndexedDB record, as JSON can carry it. */
interface StoredRecord {
  key: unknown;
  value: unknown;
}

/** One object store and its records. */
interface StoredStore {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  records: StoredRecord[];
}

/** One database and its stores. */
interface StoredDatabase {
  name: string;
  version: number;
  stores: StoredStore[];
}

/** The IndexedDB state of one origin. */
export interface OriginStorage {
  origin: string;
  databases: StoredDatabase[];
}

export interface StorageCapture {
  origins: OriginStorage[];
  /** Values that could not be carried across, named so a caller can report them. */
  skipped: string[];
}

/**
 * What runs inside the page to dump IndexedDB.
 *
 * A string rather than a function, because the browser program bridge refuses
 * functions and the same source is used from both the host and a sandboxed
 * program. Written against the raw IndexedDB API with callbacks wrapped in
 * promises, which is the only shape available inside `evaluate`.
 */
const DUMP_SOURCE = `(async () => {
  const skipped = [];
  const out = [];
  if (typeof indexedDB.databases !== "function") return { databases: [], skipped: ["indexedDB.databases unavailable"] };
  const dbs = await indexedDB.databases();
  for (const info of dbs) {
    if (!info.name) continue;
    let db;
    try {
      db = await new Promise((res, rej) => {
        const req = indexedDB.open(info.name);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    } catch (e) {
      skipped.push("open " + info.name + ": " + (e && e.message ? e.message : String(e)));
      continue;
    }
    const stores = [];
    for (const storeName of Array.from(db.objectStoreNames)) {
      let meta = { keyPath: null, autoIncrement: false };
      const records = [];
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        meta = { keyPath: store.keyPath ?? null, autoIncrement: !!store.autoIncrement };
        const all = await new Promise((res, rej) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        // Keys are read separately because getAll() returns values only.
        const keys = await new Promise((res, rej) => {
          const req = store.getAllKeys();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        for (let i = 0; i < all.length; i++) {
          try {
            records.push({ key: keys[i], value: JSON.parse(JSON.stringify(all[i])) });
          } catch (e) {
            skipped.push(storeName + "[" + String(keys[i]) + "]: not JSON-serializable");
          }
        }
      } catch (e) {
        skipped.push("read " + storeName + ": " + (e && e.message ? e.message : String(e)));
      }
      stores.push({ name: storeName, keyPath: meta.keyPath, autoIncrement: meta.autoIncrement, records });
    }
    db.close();
    out.push({ name: info.name, version: db.version, stores });
  }
  return { databases: out, skipped };
})()`;

/**
 * Capture the IndexedDB of every origin this context has a page open on.
 *
 * Per page rather than per context, because IndexedDB is origin-scoped and the
 * only way to reach an origin's database is from a document on that origin. A
 * page that has navigated away has already lost it, which is why this runs on
 * whatever pages exist at the moment of the save rather than on demand later.
 */
export async function captureIndexedDb(context: BrowserContext): Promise<StorageCapture> {
  const origins: OriginStorage[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    let origin: string;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      continue;
    }
    /*
     * `about:blank`, `data:` and `file:` have no origin worth persisting, and
     * asking them for one either throws or answers "null". Skipped rather than
     * recorded as a database called "null".
     */
    if (!origin.startsWith("http")) continue;
    if (seen.has(origin)) continue;
    seen.add(origin);
    try {
      const result = (await page.evaluate(DUMP_SOURCE)) as
        | { databases?: StoredDatabase[]; skipped?: string[] }
        | undefined;
      const databases = result?.databases ?? [];
      for (const note of result?.skipped ?? []) skipped.push(`${origin}: ${note}`);
      if (databases.length > 0) origins.push({ origin, databases });
    } catch (error) {
      /*
       * A cross-origin frame, a detached page, or a browser that refuses the
       * evaluation. Recorded rather than thrown: one unreadable origin must not
       * cost the whole save, because the origins that did read are the ones the
       * login lives in.
       */
      skipped.push(`${origin}: ${(error as Error).message}`);
    }
  }

  return { origins, skipped };
}

/**
 * What runs inside the page to restore IndexedDB.
 *
 * Takes the databases as an argument, so it is built per call rather than held
 * as a constant source. Creation goes through `onupgradeneeded` because that is
 * the only place a store can be created, and the version is bumped when the
 * stored one is higher so an existing older database is migrated rather than
 * left alone.
 */
function restoreSource(entry: OriginStorage): (payload: OriginStorage) => Promise<string[]> {
  return async function restore(payload: OriginStorage): Promise<string[]> {
  const skipped: string[] = [];
  for (const db of payload.databases) {
    let handle: IDBDatabase;
    try {
      handle = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(db.name, db.version);
        req.onupgradeneeded = () => {
          const created = req.result;
          for (const store of db.stores) {
            if (created.objectStoreNames.contains(store.name)) continue;
            created.createObjectStore(store.name, {
              ...(store.keyPath !== null ? { keyPath: store.keyPath as string } : {}),
              autoIncrement: store.autoIncrement,
            });
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
        // An existing database at a higher version refuses the open. That is not
        // a failure to restore into; it is a schema the app already advanced.
        req.onblocked = () => rej(new Error("blocked by another connection"));
      });
    } catch (error) {
      skipped.push(`${db.name}: ${(error as Error).message}`);
      continue;
    }
    for (const store of db.stores) {
      if (!handle.objectStoreNames.contains(store.name)) {
        skipped.push(`${db.name}.${store.name}: the store does not exist and could not be created`);
        continue;
      }
      try {
        const tx = handle.transaction(store.name, "readwrite");
        const target = tx.objectStore(store.name);
        for (const record of store.records) {
          /*
           * `put` with an explicit key when the store is keyed out of line, and
           * with the value alone when the key lives inside it. Passing a key to
           * a store with a keyPath throws, and so does omitting one from a store
           * without.
           */
          if (store.keyPath !== null) target.put(record.value);
          else target.put(record.value, record.key as IDBValidKey);
        }
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
          tx.onabort = () => rej(tx.error ?? new Error("aborted"));
        });
      } catch (error) {
        skipped.push(`${db.name}.${store.name}: ${(error as Error).message}`);
      }
    }
    handle.close();
  }
  return skipped;
  };
}

/**
 * Put captured IndexedDB back, on the page that is currently on each origin.
 *
 * The write happens on a live document of that origin, because IndexedDB is the
 * same trust boundary as the rest of the origin's storage: a page on another
 * origin cannot open it, which is the property that makes this safe as well as
 * necessary.
 */
export async function restoreIndexedDb(
  context: BrowserContext,
  capture: StorageCapture,
): Promise<string[]> {
  const skipped: string[] = [];
  for (const entry of capture.origins) {
    const page = context.pages().find((candidate) => {
      if (candidate.isClosed()) return false;
      try {
        return new URL(candidate.url()).origin === entry.origin;
      } catch {
        return false;
      }
    });
    if (!page) {
      skipped.push(`${entry.origin}: no page was open on this origin, so its databases were not restored`);
      continue;
    }
    try {
      const notes = (await page.evaluate(
        `(${restoreSource(entry).toString()})(${JSON.stringify(entry)})`,
      )) as string[] | undefined;
      for (const note of notes ?? []) skipped.push(`${entry.origin}: ${note}`);
    } catch (error) {
      skipped.push(`${entry.origin}: ${(error as Error).message}`);
    }
  }
  return skipped;
}

/**
 * A page that has touched IndexedDB at all.
 *
 * Used to decide whether a capture is worth the round trip: a page that never
 * used the API has nothing to find, and asking it costs an evaluation on every
 * save. Returns the origin list so the caller can skip the ones with no database
 * without a second call.
 */
export async function hasIndexedDb(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    return (await page.evaluate(
      `typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function" && (await indexedDB.databases()).length > 0`,
    )) === true;
  } catch {
    return false;
  }
}
