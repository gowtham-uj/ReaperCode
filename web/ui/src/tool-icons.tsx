/**
 * The transcript's icons, drawn rather than typed.
 *
 * These were unicode characters until a screenshot against the reference made
 * the problem obvious: "⌕", "◫" and "›_" are glyphs a given font may or may not
 * have, they sit on the text baseline at whatever weight the font decides, and
 * at 11px in a 22px tile several of them rendered as a box. A column of tiles is
 * the thing the eye runs down to find an edit among twenty reads, so the one
 * requirement is that the shapes be distinguishable and identical in weight.
 * Paths satisfy that on every machine; a font stack does not.
 *
 * One stroke width, one viewbox, `currentColor` throughout, so a tile's colour
 * is decided by the tile and never by the icon.
 */

import type { ReactElement } from "react";

export type IconName =
  | "search"
  | "read"
  | "list"
  | "edit"
  | "command"
  | "test"
  | "eval"
  | "agent"
  | "web"
  | "browser"
  | "config"
  | "generic";

/**
 * 16x16, 1.5px strokes, round caps. Sized down by the tile rather than redrawn,
 * because two sizes of the same icon drift and the difference shows most at the
 * size nobody checked.
 */
const PATHS: Record<IconName, ReactElement> = {
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.3" />
      <path d="m10.4 10.4 3 3" />
    </>
  ),
  read: (
    <>
      <rect x="3" y="2.4" width="10" height="11.2" rx="1.6" />
      <path d="M5.6 5.8h4.8M5.6 8h4.8M5.6 10.2h3" />
    </>
  ),
  list: (
    <>
      <path d="M2.6 2.9h3.1l1.2 1.5h6.5v8.7H2.6Z" />
      <path d="M5.4 7.6h5.2M5.4 10h3.4" />
    </>
  ),
  edit: (
    <>
      <path d="M10.9 2.6 13.4 5.1 5.6 12.9 2.6 13.4l.5-3Z" />
      <path d="m9.4 4.1 2.5 2.5" />
    </>
  ),
  command: (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.8" />
      <path d="m5 6.6 2 1.7-2 1.7M8.8 10.2h2.6" />
    </>
  ),
  /*
   * A flask, not a check in a circle.
   *
   * The check was the same glyph the success mark draws, in the same green, 8px
   * away from it — so a passing test run said "success" twice and "test" not at
   * all. The icon's job is to name the kind of call; whether it passed is what
   * the rail mark beside it is for.
   */
  test: (
    <>
      <path d="M6.3 2.3v4.2L3.4 11.5a1.5 1.5 0 0 0 1.3 2.2h6.6a1.5 1.5 0 0 0 1.3-2.2L9.7 6.5V2.3" />
      <path d="M5.3 2.3h5.4M5 10.3h6" />
    </>
  ),
  eval: (
    <>
      <path d="M6.4 2.6c-1.7 0-1.7 2.2-1.7 3.4S3.9 8 3.1 8c.8 0 1.6.9 1.6 2s0 3.4 1.7 3.4" />
      <path d="M9.6 2.6c1.7 0 1.7 2.2 1.7 3.4s.8 2 1.6 2c-.8 0-1.6.9-1.6 2s0 3.4-1.7 3.4" />
    </>
  ),
  agent: (
    <>
      <circle cx="8" cy="4.2" r="2" />
      <circle cx="4" cy="11.6" r="2" />
      <circle cx="12" cy="11.6" r="2" />
      <path d="M6.8 6 5.1 9.8M9.2 6l1.7 3.8" />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.4 8h11.2" />
      <path d="M8 2.4c1.5 1.6 2.3 3.5 2.3 5.6S9.5 12 8 13.6C6.5 12 5.7 10.1 5.7 8S6.5 4 8 2.4Z" />
    </>
  ),
  browser: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.8" />
      <path d="M2 6.2h12M4.4 4.6h.01M6.4 4.6h.01" />
    </>
  ),
  config: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.9v1.6M8 12.5v1.6M13.1 8h-1.6M4.5 8H2.9M11.6 4.4 10.5 5.5M5.5 10.5l-1.1 1.1M11.6 11.6l-1.1-1.1M5.5 5.5 4.4 4.4" />
    </>
  ),
  generic: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5.2v3.4M8 10.6h.01" />
    </>
  ),
};

export function ToolIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="tool-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
