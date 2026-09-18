/**
 * Tailwind, scoped to the markdown renderer and nowhere else.
 *
 * Streamdown is built with Tailwind utility classes — `space-y-4`,
 * `font-semibold`, `bg-muted` — and Reaper's UI is a hand-written stylesheet over
 * its own `--dsw-*` tokens with no Tailwind at all. So its classes were inert:
 * the markup came out structurally right and visually unstyled.
 *
 * There are two ways to reconcile that and only one of them is safe. Converting
 * the UI to Tailwind would mean rewriting a design system that already works and
 * running two styling languages side by side in one codebase. This is the other
 * way: compile only the utilities Streamdown actually uses, and scope every one
 * of them to `.markdown`, so a Tailwind class cannot leak out and restyle the
 * sidebar.
 *
 * Three settings make that work, and each is load-bearing:
 *
 *   - `content` is the Streamdown packages, not our source. Tailwind emits only
 *     the classes it finds, so this produces exactly the set its components use
 *     and not a kilobyte more.
 *   - `important: ".markdown"` scopes every rule to a descendant of the renderer.
 *     Without it, `text-sm` from Streamdown and `text-sm` from anywhere else
 *     would be the same rule and the two systems could not coexist.
 *   - `preflight: false` because Tailwind's base reset would restyle every
 *     element in the app. Streamdown does not need it: Reaper already has a
 *     normalising stylesheet.
 */

import { fileURLToPath } from "node:url";

export default {
  content: [
    /*
     * Absolute, via `fileURLToPath`, because a relative glob resolves against
     * the process's working directory and Tailwind is invoked from the repo root
     * by the build script and from `web/ui` by a developer running vitest. The
     * first version used `./node_modules/...`, which matched nothing from the
     * root and silently produced an empty stylesheet: no error, no utilities, and
     * markdown that looked unstyled for reasons nothing reported.
     */
    fileURLToPath(new URL("../../node_modules/streamdown/dist/**/*.js", import.meta.url)),
    fileURLToPath(new URL("../../node_modules/@streamdown/code/dist/**/*.js", import.meta.url)),
  ],
  corePlugins: {
    /*
     * The reset is the one part of Tailwind that is not scoped by `important`,
     * because it targets bare elements rather than classes. Leaving it on would
     * change every button, input and heading in the app.
     */
    preflight: false,
  },
  // Every utility becomes `.markdown .space-y-4`, so nothing escapes the renderer.
  important: ".markdown",
  theme: {
    extend: {
      /*
       * The semantic tokens Streamdown's classes name, mapped onto Reaper's own.
       *
       * The names are shadcn's, because that is the vocabulary the component
       * ecosystem speaks: `bg-background`, `text-muted-foreground`,
       * `border-border`, `bg-sidebar`. Mapping them here rather than editing
       * Streamdown's source is what lets it follow Reaper's theme, including
       * light and dark, without either side knowing about the other.
       */
      colors: {
        background: "var(--dsw-alias-bg-base)",
        foreground: "var(--dsw-alias-label-primary)",
        border: "var(--dsw-alias-border-l2)",
        muted: "var(--dsw-alias-bg-l1)",
        "muted-foreground": "var(--dsw-alias-label-caption)",
        primary: "var(--dsw-alias-state-business-primary)",
        "primary-foreground": "var(--dsw-alias-label-primary)",
        sidebar: "var(--dsw-alias-bg-l1)",
      },
    },
  },
  plugins: [],
};
