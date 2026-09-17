/**
 * Shared inline icons.
 *
 * These replaced text glyphs ("⌄", "✓", "●") used as icons. A glyph renders at
 * whatever size and baseline the surrounding font decides, differs per platform
 * font stack, and is read aloud by screen readers as its Unicode name. Drawn
 * paths sit on the shared stroke weight and are hidden from assistive tech,
 * leaving the label to carry the meaning.
 */

/**
 * No `open` prop: the rotation is driven by the wrapper's `[data-open]` (see
 * `.model-trigger-chevron[data-open] svg`), so a prop here was always
 * undefined and the className it carried matched no rule.
 */
export function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="m3.6 8.4 2.9 2.9 5.9-6.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Sliders, for the control that opens a thread's own settings. */
export function TuneIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M3 6.5h9M15.5 6.5H17M3 13.5h3M9 13.5h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="13.7" cy="6.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="7.2" cy="13.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * A trash can, for deleting a thread.
 *
 * Drawn rather than an emoji, for the same reason every icon here is: an emoji
 * renders differently on every platform and cannot take the surrounding colour.
 */
export function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4h11M6 4V2.75A.75.75 0 0 1 6.75 2h2.5a.75.75 0 0 1 .75.75V4m3 0-.6 8.6a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 4"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
