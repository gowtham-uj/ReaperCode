/**
 * Which thread owns which page.
 *
 * ## Why this is a module and not a field
 *
 * Steel's default context is shared by every thread, because pages have to
 * outlive a client connection to be persistent at all: a context created over
 * CDP is destroyed when that connection goes away, which was measured, while the
 * browser's own default context keeps its pages and their live state across a
 * reconnect. So `context.pages()` returns every thread's tabs.
 *
 * Two places need to know which of those are whose, and they sit on opposite
 * sides of the sandbox boundary:
 *
 *   - `ThreadBrowserRuntime`, which builds a thread's page list and decides what
 *     `setActive` may select.
 *   - `scoped-page.ts`, which runs inside the proxy a model's program holds and
 *     has to refuse a chain that walks to another thread's tab.
 *
 * The scoping layer has no runtime to ask: it is constructed per page and knows
 * nothing about threads. Threading an owner through every scope function would
 * touch a dozen call sites and would still be a copy of the answer. So the
 * answer lives here, keyed by CDP target id, which is the one identifier the
 * browser itself maintains for the life of a tab.
 *
 * ## What is authoritative
 *
 * The map is process-local and is rebuilt on attach from each thread's own state
 * file, so it survives a restart of the app-server without ever being a second
 * source of truth: the state files are the record, and this is the index that
 * makes them cheap to consult.
 */

/** Target id to owning thread id. */
const owners = new Map<string, string>();

/** Record a page as belonging to a thread. */
export function setPageOwner(targetId: string, threadId: string): void {
  owners.set(targetId, threadId);
}

/** Who owns a page, or undefined when nobody has recorded it. */
export function pageOwner(targetId: string): string | undefined {
  return owners.get(targetId);
}

/**
 * Whether a thread may use a page.
 *
 * An unrecorded page is not owned by anyone, so the answer is no: a page nobody
 * has claimed belongs to whoever put it on screen, and a thread that adopted it
 * would be taking another thread's tab. Ownership is never inferred here, only
 * recorded at creation or read from a state file, which is what makes "no" the
 * safe answer rather than the lossy one.
 */
export function isPageOwnedBy(targetId: string, threadId: string): boolean {
  return owners.get(targetId) === threadId;
}

/** Forget a page, when its target is gone for good. */
export function forgetPage(targetId: string): void {
  owners.delete(targetId);
}

/** Every page a thread owns, for a caller that needs to enumerate them. */
export function ownedBy(threadId: string): string[] {
  const out: string[] = [];
  for (const [targetId, owner] of owners) {
    if (owner === threadId) out.push(targetId);
  }
  return out;
}

/** Test hook: clear the registry so one test cannot leak ownership into the next. */
export function resetOwnership(): void {
  owners.clear();
}
