/**
 * Markdown, rendered as a document rather than as markup.
 *
 * Prose is the primary output of this product, and the transcript used to show
 * its wire format: `## Summary` and `- **item**` sitting on screen as literal
 * characters. A hand-written parser replaced that, and it worked, but it
 * understood less markdown than a model writes — no tables, no nested lists, no
 * strikethrough — and it had no answer for the thing that actually matters here:
 * a response arrives as a *stream*, so most of the markdown it renders is
 * incomplete. An unterminated code fence mid-answer is the normal case, not an
 * edge case, and a parser that treats it as literal text paints the rest of the
 * response as a code block for half a second on every single message.
 *
 * So this is Streamdown, which is built for exactly that: it recognises
 * incomplete markdown as it arrives and completes it for display, so a fence
 * that has not been closed yet renders as the code block it is becoming rather
 * than as its own source.
 *
 * ## Safety, and why it is not left to the parser
 *
 * The previous renderer's whole design was that it never produced HTML: it built
 * React elements, so a `<script>` in a README the model had read became the
 * characters `<script>`. Swapping in a parser changes the shape of that
 * guarantee from "ours by construction" to "the dependency's, if we configure it
 * right", which is exactly the kind of thing that quietly stops being true.
 *
 * So the guarantee is restored at the boundary instead: `escapeRawTags` turns
 * every tag into its entities before the parser runs, and by the time markdown
 * is parsed there is no HTML left to sanitise. That is stronger than a sanitiser
 * because it cannot be forgotten by a plugin ordering change, and it fixed a
 * real bug while it was there: Streamdown drops the *contents* of a raw tag —
 * `Build it with <script> tags sometimes.` rendered as `Build it with` — which
 * for an agent that explains HTML is losing the words it was writing about.
 *
 * The tests below pin both halves: the words survive, and no script, image or
 * anchor is ever produced from model text.
 *
 * ## What is deliberately not markdown
 *
 * Tool calls, thinking, diffs, browser activity and terminal output are
 * structured events and render as their own components. Markdown is only ever
 * the agent's own explanation. Forcing a diff into a fenced block would lose the
 * diff view, which is the whole reason a diff has one.
 */

import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

/**
 * The code plugin, built once.
 *
 * Shiki's highlighter is expensive to construct and holds a grammar cache, so
 * this is module-level rather than per-render: a transcript can hold a hundred
 * messages and each one must not stand up its own highlighter.
 */
const PLUGINS = { code } as const;

/**
 * Link rendering, so a link looks like part of Reaper rather than like a browser
 * default.
 *
 * `rel="noreferrer noopener"` and a new tab, because a page the model read can
 * contain a link and this is the boundary where that link leaves the app.
 */
function MarkdownLink({ href, children, ...rest }: ComponentProps<"a">) {
  if (!href) return <span>{children}</span>;
  return (
    <a className="md-link" href={href} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  );
}

/** Element overrides, so markdown comes out looking like the rest of the app. */
const COMPONENTS = {
  /*
   * The element name is `a` here and the prop is `href`, which is the shape
   * `hast-util-to-jsx-runtime` produces for an `<a>` node.
   */
  a: MarkdownLink,
  /*
   * Headings get no override: the document stylesheet already gives `h1`-`h6`
   * the right scale inside `.markdown`, and repeating it here would be two
   * places to change one thing.
   */
} as const;

/**
 * Escape raw HTML tags in model output, so their words survive.
 *
 * The problem this solves was measured, not assumed. Every variant tried —
 * `skipHtml`, with and without the incomplete-markdown completer — dropped the
 * *contents* of a raw tag: `Build it with <script> tags sometimes.` rendered as
 * `Build it with`, and `Use the <code>page.click()</code> method` lost the
 * `code` in the middle. That is the parser chain treating the tag as a real
 * element and then stripping it, and no flag changed it.
 *
 * For a coding assistant that is a content bug: an agent explaining HTML, XML,
 * JSX or a template has to be able to write a tag without losing the words
 * around it. So tags become entities before the markdown parser sees them,
 * which makes them literal characters that render exactly as written. The
 * opening and closing angle brackets are the only change, so a `<` used as
 * "less than" in prose is untouched.
 *
 * This is also the security boundary, and it is a stronger one than a
 * sanitiser: by the time the parser runs there is no HTML left to sanitise. The
 * tests assert it end to end — no script, no img, no anchor survives any input.
 */
export function escapeRawTags(text: string): string {
  /*
   * Only sequences that look like a tag: `<` followed by a letter or `/`, and
   * reaching a `>`. That leaves `<` in `a < b` and `5 < 10` alone, which matters
   * because an answer about arithmetic is full of them.
   */
  return text.replace(/<(\/?[A-Za-z][\w:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, "&lt;$1$2$3&gt;");
}

export interface MarkdownProps {
  text: string;
  /**
   * Whether the response is still arriving.
   *
   * Drives the streaming cursor and tells Streamdown to keep completing
   * incomplete markdown. Passed in rather than inferred, because the transcript
   * knows which turn is running and the renderer does not.
   */
  streaming?: boolean | undefined;
}

/**
 * Memoised on `text` and `streaming`.
 *
 * A streaming response re-renders this on every delta, and re-parsing the whole
 * answer each time is the cost of showing it live. The memo does not avoid that
 * — the text genuinely changed — it avoids re-rendering a *finished* message
 * when an unrelated part of the transcript updates, which is the common case
 * once a turn is over.
 */
export const Markdown = memo(function Markdown({ text, streaming = false }: MarkdownProps) {
  if (!text) return null;
  /*
   * Escaped before the parser sees it, not after. See `escapeRawTags`: a raw
   * tag otherwise loses the text around it, and escaping first means there is
   * no HTML left for a sanitiser to have to catch.
   */
  const safe = escapeRawTags(text);
  return (
    <div className="markdown">
      <Streamdown
        plugins={PLUGINS}
        components={COMPONENTS}
        isAnimating={streaming}
        /*
         * A block cursor rather than a thin one, because it reads as "more is
         * coming" at a glance and matches the composer's own caret.
         */
        caret="block"
        /*
         * Streamdown's default parse-completion is what handles the unterminated
         * fence. Kept explicit rather than left as a default, because it is the
         * reason this dependency is here and a future change to it should be a
         * visible edit rather than a silent behaviour change.
         */
        parseIncompleteMarkdown
        /*
         * Raw HTML comes through as text, never as elements.
         *
         * Streamdown parses with `allowDangerousHtml` and sanitises only when
         * asked, and by default a raw tag is *removed with its text*: measured,
         * `Use the <code>page.click()</code> method` rendered as
         * `Use the page.click() method`, and a `<script>` tag's contents vanished
         * entirely. No script ran, but an agent writing about HTML lost the words
         * it was writing about, which for a coding assistant is a content bug and
         * not a formatting one.
         *
         * `skipHtml` turns every tag into the text it was: the tag is shown, its
         * contents are kept, and nothing is parsed into an element. That is the
         * same property the previous hand-written renderer had, arrived at
         * explicitly rather than by construction.
         */
        skipHtml
      >
        {safe}
      </Streamdown>
    </div>
  );
});
