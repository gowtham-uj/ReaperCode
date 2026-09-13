/**
 * Markdown, rendered as React elements.
 *
 * The model writes markdown — headings, lists, bold, fenced code — and the
 * transcript showed it as raw text: `## Summary` and `- **item**` sitting on
 * screen as literal characters. That is not a styling gap. Prose is the primary
 * output of this product, and showing its markup is showing the wire format
 * instead of the answer.
 *
 * **Rendered as elements, never as HTML.** The obvious implementation is
 * `marked` plus `dangerouslySetInnerHTML`, which is what every markdown recipe
 * suggests and which would be a defect here: model output is untrusted text
 * derived from files, web pages and tool results, and handing it to the DOM as
 * HTML means a `<script>` in a README the model read becomes script in Reaper's
 * own origin. The usual answer is a sanitizer — `DOMPurify` is not a dependency
 * of this repo, and adding one to render a bullet list is a poor trade when the
 * safer version is also the smaller one.
 *
 * So this is a small block parser that produces React nodes. React escapes text
 * on the way in, so there is nothing to sanitize: a `<script>` tag in the
 * markdown becomes the characters `<script>`, which is what it should be. The
 * cost is that it understands less markdown than `marked` does — no reference
 * links, no nested lists deeper than one level, no HTML passthrough. That is a
 * deliberate limit: the model writes answers, not documents, and a parser whose
 * behaviour is obvious is worth more here than one whose coverage is complete.
 */

import { memo, type ReactNode } from "react";

/** A fenced block: ```lang … ``` */
interface Fence {
  kind: "fence";
  language: string;
  text: string;
}

/** A run of non-fenced lines. */
interface Prose {
  kind: "prose";
  lines: string[];
}

type Block = Fence | Prose;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;

/**
 * Split into top-level blocks, respecting fences.
 *
 * Fences are found first and treated as opaque, because everything inside one
 * is literal text — a `#` at the start of a line in a shell snippet is a
 * comment, not a heading, and parsing the inside as markdown is how a code
 * block ends up with a heading in the middle of it.
 */
function toBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    if (prose.length > 0) blocks.push({ kind: "prose", lines: prose });
    prose = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (!open) {
      prose.push(line);
      continue;
    }
    /*
     * An unterminated fence is common while a response is still streaming —
     * the opening ```` ``` ```` has arrived and the closing one has not. Treat
     * the rest of the text as that block rather than falling back to prose, so
     * the code being written renders as code while it is being written.
     */
    const marker = open[1] ?? "```";
    const language = open[2] ?? "";
    const body: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j] ?? "";
      if (candidate.trimStart().startsWith(marker)) {
        i = j;
        closed = true;
        break;
      }
      body.push(candidate);
    }
    if (!closed) i = lines.length;
    flushProse();
    blocks.push({ kind: "fence", language, text: body.join("\n") });
  }
  flushProse();
  return blocks;
}

/**
 * Inline markup: code spans, bold, italic, links.
 *
 * Ordered by precedence and applied in one pass, because doing them in sequence
 * over the same string means a `*` inside a code span gets treated as emphasis —
 * the classic reason markdown renderers get `a_b_c` wrong.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\bhttps?:\/\/[^\s)]+)|(\[[^\]]+\]\([^)\s]+\))/g;

  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${n++}`;

    if (token.startsWith("`")) {
      out.push(<code className="md-code" key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      /*
       * Only http(s). A `javascript:` or `data:` href from model output would
       * be a live payload in Reaper's origin, and a link is not worth that.
       * Anything else renders as its own text, which is honest and inert.
       */
      if (link && /^https?:\/\//i.test(link[2] ?? "")) {
        out.push(
          <a className="md-link" href={link[2]} key={key} rel="noreferrer noopener" target="_blank">
            {link[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    } else {
      out.push(
        <a className="md-link" href={token} key={key} rel="noreferrer noopener" target="_blank">
          {token}
        </a>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

function renderProse(lines: string[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = `${keyPrefix}-p${n++}`;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push(<hr className="md-rule" key={key} />);
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] ?? "#").length);
      /*
       * Rendered as a real heading element rather than a styled div, because
       * the transcript is a document and a screen reader's heading navigation
       * is how someone moves through a long answer.
       */
      const Tag = `h${Math.min(6, level + 2)}` as "h3";
      out.push(<Tag className="md-heading" key={key}>{renderInline(heading[2] ?? "", key)}</Tag>);
      i += 1;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        const m = ordered ? ORDERED.exec(candidate) : BULLET.exec(candidate);
        if (!m) break;
        items.push(m[1] ?? "");
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      out.push(
        <ListTag className="md-list" key={key}>
          {items.map((item, index) => (
            <li key={`${key}-li${index}`}>{renderInline(item, `${key}-li${index}`)}</li>
          ))}
        </ListTag>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] ?? "")) {
        quoted.push(QUOTE.exec(lines[i] ?? "")?.[1] ?? "");
        i += 1;
      }
      out.push(
        <blockquote className="md-quote" key={key}>
          {renderInline(quoted.join(" "), key)}
        </blockquote>,
      );
      continue;
    }

    /*
     * A paragraph runs until a blank line or a line that starts a different
     * block. Joining with a space rather than a newline is the markdown rule,
     * and it is also what makes a streamed response reflow instead of growing
     * a ragged right edge as each wrapped line arrives.
     */
    const paragraph: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i] ?? "";
      if (
        candidate.trim() === ""
        || BULLET.test(candidate)
        || ORDERED.test(candidate)
        || HEADING.test(candidate)
        || QUOTE.test(candidate)
        || RULE.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate.trim());
      i += 1;
    }
    out.push(<p className="md-paragraph" key={key}>{renderInline(paragraph.join(" "), key)}</p>);
  }
  return out;
}

/**
 * A fenced code block.
 *
 * Reuses the `.code-block` / `.code-line` / `.code-gutter` classes Code Mode
 * already styles, so the transcript has one code presentation rather than two
 * that drift apart. Line numbers are shown only past a handful of lines: three
 * lines of shell do not need numbering, and a gutter on every snippet is noise.
 */
function CodeFence({ language, text }: { language: string; text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  const numbered = lines.length > 4;
  return (
    <div className="md-fence">
      {language && <div className="md-fence-lang">{language}</div>}
      <div className="code-block" data-code>
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            {numbered && <span className="code-gutter" aria-hidden="true">{index + 1}</span>}
            <span className="code-text">{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Memoised on `text`, which is the whole point: a streaming response re-renders
 * this component on every delta, and re-parsing the entire answer each time
 * would make a long response quadratic. The memo does not avoid the reparse —
 * the text genuinely changed — but it does avoid re-rendering a *finished*
 * message when an unrelated part of the transcript updates, which is the
 * common case once a turn is over.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="markdown">
      {toBlocks(text).map((block, index) =>
        block.kind === "fence" ? (
          <CodeFence key={`f${index}`} language={block.language} text={block.text} />
        ) : (
          <div key={`p${index}`}>{renderProse(block.lines, `b${index}`)}</div>
        ),
      )}
    </div>
  );
});
