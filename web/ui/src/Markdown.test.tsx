/**
 * Markdown rendering, and the security property that comes with it.
 *
 * The interesting assertions are not "does a bullet render". They are: model
 * output must never become live DOM, and a response still arriving — with an
 * unterminated code fence, which is the normal state mid-stream — must render as
 * code rather than as prose. Those two are now properties of Streamdown rather
 * than of our own forty-line parser, which is exactly why they are pinned here:
 * a dependency swap must not be able to quietly drop either of them.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Markdown, escapeRawTags } from "./Markdown.js";

describe("Markdown", () => {
  it("renders headings, lists, emphasis and inline code", () => {
    const { container } = render(
      <Markdown text={"## Summary\n\n- **first** item\n- second with `code`\n\nA paragraph."} />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Summary");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    /*
     * Emphasis is asserted by what it renders, not by its tag name. Streamdown
     * emits a `span` carrying its weight class rather than a `<strong>`, and the
     * markup a reader gets is its choice to make; what matters here is that the
     * emphasis produced a distinct element around the right words and the list
     * still reads as a list.
     */
    const bold = container.querySelector("[data-streamdown='strong']");
    expect(bold?.textContent).toBe("first");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelector("p")?.textContent).toBe("A paragraph.");
  });

  it("renders a fenced block as code, not as prose", () => {
    const { container } = render(
      <Markdown text={"Try this:\n\n```js\nconst a = 1;\n# not a heading\n```\n\ndone"} />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    // The `#` inside the fence must stay literal: a shell comment is not a heading.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("# not a heading");
  });

  it("renders a fence that has not been closed yet, which is the streaming case", () => {
    /*
     * Mid-stream, the opening ``` has arrived and the closing one has not. This
     * is the case the previous hand-written parser had to special-case and the
     * reason Streamdown is here: a naive parser renders the rest of the answer as
     * a paragraph, so the code being written appears as prose — at the one moment
     * the reader is actually watching.
     */
    const { container } = render(<Markdown text={"Here:\n\n```python\ndef f():\n    return 1"} streaming />);
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("Here:");
  });

  it("renders a table, which the hand-written parser could not", () => {
    const { container } = render(<Markdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("never lets model output become live DOM", () => {
    /*
     * The security assertion, and the one that matters most now that rendering
     * goes through a third-party parser. Model output is derived from files, web
     * pages and tool results — untrusted text — and the usual markdown recipe
     * hands it to `dangerouslySetInnerHTML`. Whatever the engine, a script tag in
     * the text must end up as characters on screen rather than as a script in
     * Reaper's origin.
     */
    const hostile = [
      "<script>window.__pwned = true;</script>",
      "<img src=x onerror=\"window.__pwned = true\">",
      "[click](javascript:window.__pwned=true)",
      "<iframe src=\"https://evil.example\"></iframe>",
      "<a href=\"javascript:alert(1)\">x</a>",
    ].join("\n\n");
    const { container } = render(<Markdown text={hostile} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    // An image with an event handler is the classic vector; no handler survives.
    for (const img of Array.from(container.querySelectorAll("img"))) {
      expect(img.getAttribute("onerror")).toBeNull();
    }
    // And no javascript: URL survives on any link, including one written as HTML.
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
      // A link out of the app must not carry the opener back with it.
      expect(anchor.getAttribute("rel") ?? "").toMatch(/noopener|noreferrer/);
    }
    // The text is still shown, escaped rather than dropped.
    expect(container.textContent).toContain("<script>");
  });

  it("renders nothing for empty text rather than an empty shell", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector(".markdown")).toBeNull();
  });

  it("joins wrapped paragraph lines instead of preserving hard breaks", () => {
    /*
     * A single newline inside a paragraph is a soft break: the words are one
     * paragraph, and the line breaks the model wrote for its own source are not
     * shown. The text keeps its newlines in the DOM and CSS collapses them, which
     * is why this reads them as one run rather than asserting on whitespace.
     */
    const { container } = render(<Markdown text={"one\ntwo\nthree"} />);
    const paragraph = container.querySelector("p");
    expect(paragraph).not.toBeNull();
    expect(paragraph!.textContent?.replace(/\s+/g, " ").trim()).toBe("one two three");
  });
});

describe("escapeRawTags", () => {
  it("keeps the words around a tag that the parser would otherwise drop", () => {
    /*
     * The bug this exists for. Streamdown removes a raw tag together with its
     * contents, so an agent explaining HTML lost the thing it was explaining:
     * `Build it with <script> tags sometimes.` rendered as `Build it with`.
     */
    expect(escapeRawTags("Build it with <script> tags sometimes.")).toBe("Build it with &lt;script&gt; tags sometimes.");
    expect(escapeRawTags("Use the <code>page.click()</code> method.")).toBe("Use the &lt;code&gt;page.click()&lt;/code&gt; method.");
  });

  it("leaves a less-than in prose alone", () => {
    // An answer about arithmetic is full of these, and escaping them would show
    // `&lt;` on screen.
    for (const text of ["if (a < b) return 1;", "5 < 10 and 10 > 5", "a <b is not a tag"]) {
      expect(escapeRawTags(text)).toBe(text);
    }
  });

  it("escapes a self-closing tag and one with attributes", () => {
    expect(escapeRawTags("<img src=x onerror=\"bad()\">")).toBe("&lt;img src=x onerror=\"bad()\"&gt;");
    expect(escapeRawTags("<br/>")).toBe("&lt;br/&gt;");
  });

  it("leaves markdown untouched", () => {
    const markdown = "## Heading\n\n- **bold** and `code`\n\n```js\nconst a = 1;\n```";
    expect(escapeRawTags(markdown)).toBe(markdown);
  });
});
