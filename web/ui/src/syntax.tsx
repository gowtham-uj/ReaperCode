/**
 * A very small syntax highlighter, for diffs only.
 *
 * The reference colours its code. Ours did not, and reading the two side by side
 * that is the loudest difference left: a monochrome diff is a wall of grey that
 * the eye has to parse word by word, where a coloured one lets a reader see at a
 * glance that the added line is a call and the removed line was a comment.
 *
 * This deliberately does not pull in a real highlighter. Shiki and Prism are
 * megabytes and want a language name we do not reliably have, and a diff hunk is
 * a fragment: it starts mid-block, its braces do not balance, and a real parser
 * has to guess anyway. A regex over five token classes gets the colour right on
 * the lines that matter and degrades to plain text rather than to nonsense when
 * it does not, which is the correct failure for something purely decorative.
 *
 * Comments and strings are matched first and win, because a keyword inside a
 * string is not a keyword. Everything after them is matched on a single pass so
 * no character can be emitted twice.
 */

import { Fragment, type ReactNode } from "react";

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "def", "default", "delete", "do", "elif", "else", "enum", "export", "extends",
  "false", "finally", "fn", "for", "from", "func", "function", "if", "impl",
  "import", "in", "instanceof", "interface", "let", "match", "new", "nil", "none",
  "null", "of", "package", "pub", "return", "self", "static", "struct", "super",
  "switch", "this", "throw", "true", "try", "type", "typeof", "undefined", "use",
  "var", "void", "while", "yield",
]);

/**
 * One expression, alternated in priority order, so a single scan cannot emit a
 * character twice. Line comments and strings come first; both swallow whatever
 * they contain.
 */
const TOKEN =
  /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|(\b\d[\w.]*\b)|([A-Za-z_$][\w$]*)(\s*\()?/g;

type Cls = "com" | "str" | "num" | "kw" | "fn";

export function highlight(code: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  const push = (text: string, cls?: Cls) => {
    if (!text) return;
    out.push(cls === undefined ? text : <span className={`hl-${cls}`} key={key++}>{text}</span>);
  };

  for (let match = TOKEN.exec(code); match !== null; match = TOKEN.exec(code)) {
    const [whole, comment, string, num, word, call] = match;
    // A bare identifier that is neither keyword nor call site gets no span at
    // all. Colouring every variable is what makes a highlighter look like a
    // highlighter rather than like code.
    const cls: Cls | undefined = comment
      ? "com"
      : string
        ? "str"
        : num
          ? "num"
          : word !== undefined && KEYWORDS.has(word)
            ? "kw"
            : word !== undefined && call !== undefined
              ? "fn"
              : undefined;
    if (cls === undefined) continue;
    push(code.slice(last, match.index));
    // The trailing "(" is matched only to identify a call, so it is not part of
    // the coloured run.
    const text = cls === "fn" ? word! : whole;
    push(text, cls);
    last = match.index + text.length;
  }
  push(code.slice(last));

  return out.length === 1 ? out[0] : <Fragment>{out}</Fragment>;
}
