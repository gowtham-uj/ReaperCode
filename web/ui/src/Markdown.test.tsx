/**
 * Markdown rendering, and the security property that comes with it.
 *
 * The interesting assertions here are not "does a bullet render". They are:
 * model output must never become live DOM, and a response still arriving —
 * with an unterminated code fence, which is the normal state mid-stream — must
 * render as code rather than as prose.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Markdown } from "./Markdown.js";

describe("Markdown", () => {
  it("renders headings, lists, emphasis and inline code as elements", () => {
    const { container } = render(
      <Markdown text={"## Summary\n\n- **first** item\n- second with `code`\n\nA paragraph."} />,
    );
    expect(container.querySelector(".md-heading")?.textContent).toBe("Summary");
    expect(container.querySelectorAll(".md-list li")).toHaveLength(2);
    expect(container.querySelector(".md-list strong")?.textContent).toBe("first");
    expect(container.querySelector(".md-code")?.textContent).toBe("code");
    expect(container.querySelector(".md-paragraph")?.textContent).toBe("A paragraph.");
  });

  it("renders a fenced block as code, not as prose", () => {
    const { container } = render(
      <Markdown text={"Try this:\n\n```js\nconst a = 1;\n# not a heading\n```\n\ndone"} />,
    );
    const fence = container.querySelector(".md-fence");
    expect(fence).not.toBeNull();
    expect(fence?.querySelector(".md-fence-lang")?.textContent).toBe("js");
    // The `#` inside the fence must stay literal — a shell comment is not a heading.
    expect(container.querySelector(".md-heading")).toBeNull();
    expect(fence?.textContent).toContain("# not a heading");
  });

  it("renders a fence that has not been closed yet, which is the streaming case", () => {
    /*
     * Mid-stream, the opening ``` has arrived and the closing one has not. The
     * naive parser would fall back to treating the rest as prose, so the code
     * being written would render as a paragraph until the fence closed — the
     * one moment the reader is actually watching.
     */
    const { container } = render(<Markdown text={"Here:\n\n```python\ndef f():\n    return 1"} />);
    expect(container.querySelector(".md-fence")).not.toBeNull();
    expect(container.querySelector(".md-paragraph")?.textContent).toBe("Here:");
  });

  it("never lets model output become live DOM", () => {
    /*
     * The security assertion. Model output is derived from files, web pages and
     * tool results — untrusted text — and the usual markdown recipe hands it to
     * `dangerouslySetInnerHTML`. This renders React elements instead, so a
     * script tag in the text is characters on screen, not a script in Reaper's
     * origin.
     */
    const hostile = [
      "<script>window.__pwned = true;</script>",
      "<img src=x onerror=\"window.__pwned = true\">",
      "[click](javascript:window.__pwned=true)",
    ].join("\n\n");
    const { container } = render(<Markdown text={hostile} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    // The link is inert: no javascript: href survives.
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    // And the text is still shown, escaped rather than dropped.
    expect(container.textContent).toContain("<script>");
  });

  it("renders nothing for empty text rather than an empty shell", () => {
    const { container } = render(<Markdown text="" />);
    expect(container.querySelector(".markdown")).toBeNull();
  });

  it("joins wrapped paragraph lines instead of preserving hard breaks", () => {
    // Markdown's rule, and the reason a streaming answer reflows instead of
    // growing a ragged edge as each wrapped line arrives.
    const { container } = render(<Markdown text={"one\ntwo\nthree"} />);
    expect(container.querySelector(".md-paragraph")?.textContent).toBe("one two three");
  });
});
