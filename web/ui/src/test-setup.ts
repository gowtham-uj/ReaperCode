/**
 * Vitest's jsdom environment copies the jsdom window's own properties onto a
 * plain object, and the `localStorage` accessor arrives without its getter —
 * so `window.localStorage` is `undefined` in tests even though the document
 * url (and therefore the origin) is set. A real browser always has it, so this
 * restores the environment to what the app actually runs in rather than
 * working around a genuine absence.
 *
 * Only installed when missing, so a future Vitest that fixes the copy keeps
 * the real implementation.
 */
class MemoryStorage implements Storage {
  #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }

  getItem(key: string): string | null {
    return this.#entries.get(String(key)) ?? null;
  }

  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#entries.delete(String(key));
  }

  setItem(key: string, value: string): void {
    this.#entries.set(String(key), String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  if (typeof window !== "undefined" && window !== (globalThis as unknown as Window)) {
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  }
}

/**
 * jsdom parses `<dialog>` but implements none of its behaviour: `showModal`,
 * `show`, and `close` are simply absent, so a component that opens a dialog in
 * a mount effect throws before it renders anything.
 *
 * This is the smallest shim that makes the *observable* contract true — `open`
 * reflects state, and `close()` dispatches a `close` event so the `onClose`
 * handler that Escape and the backdrop both route through is exercised for
 * real. Deliberately not modelled: the top layer, inertness of the rest of the
 * document, and Escape-to-cancel, none of which jsdom can express and none of
 * which a test should pretend to have verified.
 */
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  const open = (element: HTMLDialogElement): void => {
    if (element.open) return;
    element.setAttribute("open", "");
  };
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { value(this: HTMLDialogElement) { open(this); }, configurable: true, writable: true },
    show: { value(this: HTMLDialogElement) { open(this); }, configurable: true, writable: true },
    close: {
      value(this: HTMLDialogElement, returnValue?: string) {
        if (!this.open) return;
        this.removeAttribute("open");
        if (returnValue !== undefined) this.returnValue = returnValue;
        this.dispatchEvent(new Event("close"));
      },
      configurable: true,
      writable: true,
    },
  });
}

/**
 * jsdom does not implement `Element.prototype.scrollTo`.
 *
 * Streamdown scrolls a code block to its end while a response is still arriving,
 * so rendering a fenced block mid-stream calls it and throws in jsdom before
 * anything renders. A real browser always has it, so this restores the
 * environment to what the app runs in rather than working around a real
 * absence, and it does nothing: scroll position is not what these tests assert,
 * and faking a layout jsdom does not have would be worse than a no-op.
 */
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Object.defineProperty(Element.prototype, "scrollTo", {
    value: () => undefined,
    configurable: true,
    writable: true,
  });
}
