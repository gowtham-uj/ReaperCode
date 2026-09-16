/**
 * The diff highlighter, tested where it can be wrong in a way a reader notices.
 *
 * Colouring a keyword is not interesting. What is interesting is the cases where
 * a naive scanner double-emits or eats a character, because the failure there is
 * not "the wrong colour" but "the code on screen is not the code in the file",
 * and a diff that silently drops a character is worse than one with no colour at
 * all.
 */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { highlight } from "./syntax.js";

afterEach(cleanup);

function textOf(code: string): string {
  const { container } = render(<span>{highlight(code)}</span>);
  return container.textContent ?? "";
}

function classOf(code: string, needle: string): string | undefined {
  const { container } = render(<span>{highlight(code)}</span>);
  for (const span of container.querySelectorAll("span span")) {
    if (span.textContent === needle) return span.className;
  }
  return undefined;
}

describe("diff highlighting", () => {
  it("never changes the text it is colouring", () => {
    const samples = [
      `await storage.setItem("refresh_token", newTokens.refreshToken);`,
      `// was only updating in memory`,
      `const x = 42; // trailing comment with "quotes" and fn(`,
      `if (a) { return b(c, 'd'); }`,
      `def handler(self, *args): # python too`,
      ``,
      `   `,
      `}`,
    ];
    for (const sample of samples) expect(textOf(sample)).toBe(sample);
  });

  it("treats a keyword inside a string as string, not keyword", () => {
    expect(classOf(`const s = "return null";`, `"return null"`)).toBe("hl-str");
  });

  it("treats code inside a comment as comment", () => {
    expect(classOf(`// return fetch(url)`, `// return fetch(url)`)).toBe("hl-com");
  });

  it("colours a call site but not a plain identifier", () => {
    expect(classOf(`persistSession(session)`, "persistSession")).toBe("hl-fn");
    // `session` is an argument, not a call, and colouring every identifier is
    // what makes a highlighter look like a highlighter instead of like code.
    expect(classOf(`persistSession(session)`, "session")).toBeUndefined();
  });

  it("leaves text it understands nothing about entirely alone", () => {
    const { container } = render(<span>{highlight("the quick brown fox")}</span>);
    expect(container.querySelectorAll("span span").length).toBe(0);
  });
});
