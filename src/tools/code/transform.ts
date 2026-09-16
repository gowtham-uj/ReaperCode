/**
 * Rewrites a script so its last expression survives a wrapper.
 *
 * Two facts about JavaScript force this file to exist.
 *
 * The first is that the completion value of a script *is* the value of its last
 * statement, and that is exactly the return semantics Code Mode wants —
 * `values.reduce((a, b) => a + b, 0)` as the whole script evaluates to `10`
 * with no `return` and no `console.log`. That works today, unwrapped.
 *
 * The second is that top-level `await` is a syntax error in a script, and the
 * ergonomics the model is being offered — `const files = await tools.list(...)`
 * at the top of the code — need it. Wrapping the script in an async function
 * gets the `await`, and loses the completion value: a function returns
 * `undefined` unless something says `return`, and there is no hook that hands
 * a function body's completion value back.
 *
 * So for the wrapped case the trailing expression is lifted into a `return`.
 * The lifting is textual, and that is a deliberate trade: a real parser is a
 * dependency this feature does not need, and a *wrong* lift cannot produce a
 * wrong answer. Every candidate rewrite is handed to the engine that will run
 * it — V8 — to compile before it is used, so one that mis-splits the source is
 * rejected rather than run. The worst case is the wrapper without the `return`,
 * which still runs the code, still awaits every tool call, and still reports
 * whatever `console` captured.
 */

/** A position in the source where a new statement could begin. */
interface Boundary {
  index: number;
}

/**
 * Keywords after which a `/` opens a regular expression rather than dividing.
 * `return /re/` and `return a / b` are the same two tokens until the keyword is
 * known, and there is no way to tell them apart from the character before the
 * slash.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "do", "else", "case", "yield", "await", "throw",
]);

/**
 * Whether a `/` here starts a regular expression rather than a division.
 *
 * The character before the slash is not enough on its own. `a / b` and
 * `return /re/` both put a letter before the slash and mean opposite things,
 * and `.` and `)` — which end an operand, so a following `/` must divide —
 * appear in the naive "operator character" set and would be read backwards.
 *
 * Getting this wrong costs a split candidate, never a wrong answer: every
 * candidate is compiled before use, and one that mis-reads a literal does not
 * compile. But a mis-read also means the scanner can walk into a string it
 * thinks is code, so the rule is worth getting right.
 */
function startsRegex(previousChar: string, previousWord: string): boolean {
  if (previousChar === "") return true;
  // `.` cannot divide: `a.b / c` is a division of a member access.
  if (previousChar === "." || previousChar === ")" || previousChar === "]") return false;
  // `}` is ambiguous — it can close an object literal (operand) or a block
  // (statement). Division is the safer read: guessing "regex" here would treat
  // the rest of the line as a literal and swallow a real terminator.
  if (previousChar === "}") return false;
  if (/[A-Za-z0-9_$]/.test(previousChar)) return REGEX_PRECEDING_KEYWORDS.has(previousWord);
  return "(,=:[!&|?{};+-*%~^<>".includes(previousChar);
}

/**
 * Every offset at nesting depth 0 where a statement could start, earliest
 * first. Skips strings, template literals, comments, and regex literals so a
 * `;` inside a string is not mistaken for a statement terminator.
 */
function statementBoundaries(source: string): Boundary[] {
  const boundaries: Boundary[] = [{ index: 0 }];
  let depth = 0;
  let previous = "";
  let previousWord = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      previous = "x";
      continue;
    }
    if (char === "`") {
      // Template literals are skipped wholesale, `${}` interpolations
      // included. A statement boundary inside an interpolation would be a
      // legal place to split, but treating the whole literal as opaque costs
      // at most a missed candidate, and the candidates before it still cover
      // the trailing-expression case this exists for.
      index += 1;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      previous = "x";
      continue;
    }
    if (char === "/" && startsRegex(previous, previousWord)) {
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const ch = source[index]!;
        if (ch === "\\") { index += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        else if (ch === "\n") break;
        index += 1;
      }
      index += 1;
      previous = "x";
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        /*
         * Only `}` can end a statement at the top level — a function
         * declaration, a block, a `try`, a loop body.
         *
         * `)` and `]` deliberately do not. They end *expressions* that are
         * routinely still going: in `values.filter((v) => v > 1).length` the
         * inner paren returns the depth to zero halfway through the line, and
         * treating that as a statement boundary offered the splitter a tail of
         * `.length` — a fragment that is not an expression and would have been
         * lifted into `return (.length)` had the verifier not rejected it. The
         * cost of excluding them is nothing: every statement that ends in `)`
         * or `]` ends with `;` or a newline too.
         */
        if (char === "}") boundaries.push({ index: index + 1 });
      }
    } else if (char === ";" && depth === 0) {
      boundaries.push({ index: index + 1 });
    } else if (char === "\n" && depth === 0) {
      boundaries.push({ index: index + 1 });
    }

    if (!/\s/.test(char)) {
      if (/[A-Za-z0-9_$]/.test(char)) {
        // Extend the current word, so `return` is remembered whole rather than
        // as the `n` that happens to sit before the slash.
        previousWord = /[A-Za-z0-9_$]/.test(previous) ? previousWord + char : char;
      } else {
        previousWord = "";
      }
      previous = char;
    }
    index += 1;
  }

  return boundaries.filter((boundary, position) =>
    position === 0 || boundary.index > boundaries[position - 1]!.index);
}

/** Strip trailing whitespace and at most one trailing semicolon. */
function trimTail(source: string): string {
  let end = source.length;
  while (end > 0 && /\s/.test(source[end - 1]!)) end -= 1;
  if (end > 0 && source[end - 1] === ";") end -= 1;
  return source.slice(0, end);
}

/**
 * Split the source into a statement prefix and a value-producing tail.
 *
 * Returns `undefined` when no split is worth trying, in which case the caller
 * wraps without lifting. The `verify` callback is what makes this safe: it is
 * handed each candidate rewrite and answers whether it compiles, so the search
 * is over *syntactically real* splits rather than over guesses.
 */
export function splitTrailingExpression(
  source: string,
  verify: (candidate: string) => boolean,
  maxAttempts = 24,
): { prefix: string; tail: string } | undefined {
  const body = trimTail(source);
  if (body.trim().length === 0) return undefined;

  const candidates = statementBoundaries(body);
  /*
   * Longest tail first. Splitting as late as possible keeps the most code in
   * the returned expression, which is where a chained `.filter().sort()` ends
   * up; working backwards from the end is what makes the first success the
   * longest tail rather than the shortest.
   *
   * Index 0 is included, and that is not a formality. The whole script being
   * one value-producing expression is the single most common shape in Code
   * Mode — `(await tools.read({ path })).text` — and it has no prefix at all.
   * An earlier version skipped it on the reasoning that a split needs
   * something to split, which quietly meant the most natural one-liner lost
   * its result.
   */
  const ordered = candidates.reverse().slice(0, maxAttempts);

  for (const candidate of ordered) {
    const prefix = body.slice(0, candidate.index).trimEnd();
    /*
     * The tail keeps its own leading whitespace, blank lines included.
     * Trimming it would pull the expression up the file, and since the point
     * of the wrapper's shape is that a reported line is the line the model
     * wrote, a tail that started after a blank line would be off by that many
     * lines. Indentation is also the one thing about the tail a reader still
     * gets to see in a stack trace.
     */
    const tail = body.slice(candidate.index);
    if (!tail.trim()) continue;
    // Verified through the same builder that will emit it. Two definitions of
    // the wrapper shape would let the one that compiles and the one that runs
    // drift apart, and the symptom would be a script that passes its own
    // syntax check and then fails to compile.
    if (verify(wrapWithTail(prefix, tail))) return { prefix, tail };
  }
  return undefined;
}

/**
 * The opening of every wrapper, ending in a space and *without* a newline.
 *
 * The absent newline is the whole point. The engine reports a runtime failure
 * as `at <file>:LINE:COLUMN`, and the line is counted in the rewritten source —
 * so a wrapper that puts its opening brace on its own line shifts every line of
 * the model's code down by one, and every position it is told is then wrong by
 * one. Reporting a wrong line is worse than reporting none: the model goes to
 * that line, finds code that is fine, and edits the wrong thing.
 *
 * Writing the opening on the same line as the source's first line keeps every
 * line at its original number. Only the column of line 1 moves, and the
 * reported position never mentions columns, so nothing is distorted.
 */
const WRAP_OPEN = "(async () => { ";

/** The wrapper used when no tail could be lifted. */
export function wrapWithoutTail(source: string): string {
  return `${WRAP_OPEN}${source}\n})()`;
}

/**
 * Blocks whose contents always run when the construct they belong to runs, so
 * a `return` placed inside one cannot be skipped in favour of another.
 *
 * `finally` is deliberately absent. A `finally` block runs on *every* path,
 * including one that already returned from the `try` or the `catch`, so a
 * `return` lifted into it would silently discard the value the script actually
 * produced. It is the one block in the language where this rewrite would
 * change the answer rather than recover it.
 */
const TERMINAL_FOLLOWERS: ReadonlySet<string> = new Set(["else", "catch"]);

/** A brace-delimited block, and where it sits in the text being scanned. */
interface Block {
  /** Index of the `{`. */
  open: number;
  /** Index of the matching `}`. */
  close: number;
}

/**
 * Every top-level block in a fragment, in source order.
 *
 * "Top level" means depth 1 from the fragment's own frame — the `{…}` of an
 * `if` body, not the braces of an object literal nested inside one. Sits on the
 * same scanning rules as `statementBoundaries`: strings, comments and template
 * literals are stepped over rather than read as structure.
 */
function topLevelBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let open = -1;
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];

    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index += 1;
      while (index < text.length && text[index] !== char) {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === "`") {
      index += 1;
      while (index < text.length && text[index] !== "`") {
        if (text[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }

    if (char === "{") {
      depth += 1;
      if (depth === 1) open = index;
    } else if (char === "}") {
      if (depth === 1 && open >= 0) blocks.push({ open, close: index });
      depth = Math.max(0, depth - 1);
    }
    index += 1;
  }

  return blocks;
}

/** The next word after a position, for deciding what a block is followed by. */
function wordAfter(text: string, from: number): string {
  const match = /^\s*([A-Za-z]+)/.exec(text.slice(from + 1));
  return match?.[1] ?? "";
}

/**
 * Lift the value of a trailing `try`/`catch` or `if`/`else` into a `return`.
 *
 * The expression lift above handles a script that *ends in an expression*,
 * which is most of them. This handles the other common ending, where the value
 * belongs to a compound statement rather than to a fragment of one:
 *
 *     try { await tools.write_file({ path, content }) } catch (e) { e.code }
 *     if (files.length > 20) { "too many" } else { files.length }
 *
 * Both of those used to run, await every tool call, and then report nothing —
 * and the first one is not a rare shape. It is what this tool's own error
 * message tells the model to write when a tool rejects it, so a model that
 * followed the advice lost the answer it was working towards.
 *
 * There is no expression that evaluates to a statement's completion value; the
 * language only exposes those in script position. So instead of reaching for
 * the value, this puts a `return` where the value already is: inside each block
 * the statement can finish in. A `return` there is a statement the wrapper
 * already permits, and it sees the same value the completion would have been.
 *
 * Only `try` and `if` are rewritten, and only their always-taken blocks. Both
 * are shapes where every block that can produce the final value is known —
 * `switch` is not, because dropping a `return` into the last clause changes
 * what a fall-through from an earlier one does. An unrecognised ending is not
 * guessed at: the caller falls back to running the script unchanged.
 *
 * The whole rewrite is handed to `verify` before it is used, so a fragment
 * this mis-reads is rejected here rather than run.
 */
export function liftTrailingBlocks(source: string, verify: (candidate: string) => boolean): string | undefined {
  const body = trimTail(source);
  /*
   * The construct being lifted is the *last* statement, so what matters is
   * where that statement starts — not where the script does.
   *
   * This used to test `/^\s*(try|if)\b/` against the whole body, which is the
   * same question only for a script that is nothing but a try/catch. Add one
   * line of setup in front — `const fs = require('node:fs'); try { … } catch
   * { … }`, the single most common shape once scripts touch anything that can
   * fail — and the guard said no, no lift was attempted, and the script ran
   * correctly and reported no value at all.
   *
   * The blocks are still found by scanning the whole body, so the prefix is
   * preserved verbatim and only the trailing construct is rewritten.
   */
  /*
   * The *last boundary that begins a `try` or an `if`*, which is not the same
   * as the last boundary. `statementBoundaries` also marks the position after
   * a block's closing brace, so in `try { … } catch { … }` the final boundary
   * sits on `catch` — a script that is nothing but a try/catch would fail its
   * own test. Scanning for the keyword instead answers the question being
   * asked, and answers it the same way whether or not there is a prefix.
   */
  const startsConstruct = statementBoundaries(body)
    .some((boundary) => /^\s*(try|if)\b/.test(body.slice(boundary.index)));
  if (!startsConstruct) return undefined;

  const blocks = topLevelBlocks(body);
  if (blocks.length === 0) return undefined;

  let rewritten = "";
  let cursor = 0;
  let lifted = 0;

  for (const block of blocks) {
    const terminal = block.close === body.length - 1 || TERMINAL_FOLLOWERS.has(wordAfter(body, block.close));
    if (!terminal) continue;
    const inner = body.slice(block.open + 1, block.close);
    /*
     * Accepted only if the tail is genuinely an *expression*, checked here per
     * branch rather than left to the whole-rewrite check at the end.
     *
     * That delegation works when there is one block to lift and breaks when
     * there are two. `try { throw new Custom('x') } catch (e) { e.name }` has
     * a block in each branch; `throw` is a statement, not an expression, so
     * the try branch was lifted into `return ( throw … )`, which is a syntax
     * error — and since the rewrite is compiled as one unit, the catch
     * branch's perfectly good value was thrown away with it and the script
     * returned nothing.
     *
     * One branch failing to lift must not cost the other its value, so the
     * cost of a bad candidate is now confined to the branch that produced it.
     */
    const split = splitTrailingExpression(inner, verify);
    if (!split) continue;
    rewritten += body.slice(cursor, block.open + 1);
    // No newline is added: the rewrite has to stay line-for-line with what
    // the model wrote, or every position reported from a later line is wrong.
    rewritten += `${split.prefix}; return (${split.tail});`;
    cursor = block.close;
    lifted += 1;
  }

  if (lifted === 0) return undefined;
  const candidate = rewritten + body.slice(cursor);
  return verify(candidate) ? candidate : undefined;
}

/**
 * The wrapper used once a tail has been chosen.
 *
 * Three details, each load-bearing:
 *
 * `return (` is appended to the prefix's last line rather than given a line of
 * its own, so the tail lands on the line the model wrote it on.
 *
 * A `;` goes in front of it. Without one, a prefix whose last statement has no
 * semicolon runs into the keyword — `const a = 1 return (` — and every
 * candidate splits fails to compile. A doubled `;;` where the model did write
 * one is an empty statement, which is nothing.
 *
 * The tail is inserted as-is, so a tail that starts after a blank line stays
 * after that blank line.
 */
export function wrapWithTail(prefix: string, tail: string, options: { awaitTail?: boolean } = {}): string {
  /*
   * `awaitTail` is off by default and on for browser programs, which is not a
   * cosmetic difference.
   *
   * A plain eval tail is already a resolved value, so `return (x)` and
   * `return await (x)` agree, and the unawaited form is left alone because it
   * is what every existing caller was written and tested against. A browser
   * tail is often a *proxy node*: `page.context().browser().contexts().length`
   * is a chain the sandbox has not run yet, and returning it unawaited hands
   * back the node itself instead of the number. Awaiting is what runs the chain,
   * and it resolves the property read at the end of it too, because the host
   * replays the whole path including the final step.
   */
  return `${WRAP_OPEN}${prefix}; return ${options.awaitTail === true ? "await " : ""}(${tail}\n); })()`;
}

/**
 * The opening of a declaration-lift wrapper. Same line-preserving rule as
 * `WRAP_OPEN`: no newline, so the model's first line stays line 1.
 */
const DECL_LIFT_OPEN = WRAP_OPEN;

/**
 * The name a declaration statement binds, when there is exactly one and it can
 * be returned by that name: `const x = …`, `const { a } = …`, `const [a] = …`.
 *
 * Deliberately conservative. A multi-binding destructure (`const { a, b } = …`)
 * has no single obvious return value, and a defaulted binding
 * (`const { a = 1 } = …`) is more syntax than this needs to read, so both return
 * undefined and the script is left for the model to fix. The common shape the
 * skill names as the most frequent mistake — `const x = await tools.…` — is the
 * one this exists to recover.
 */
export function declarationBinding(statement: string): string | undefined {
  const trimmed = trimTail(statement).trim();
  const keyword = /^(?:const|let|var)\s+/.exec(trimmed);
  if (!keyword) return undefined;
  const rest = trimmed.slice(keyword[0].length);

  // `const x = …`
  const simple = /^([A-Za-z_$][\w$]*)\s*=/.exec(rest);
  if (simple?.[1]) return simple[1];

  // `const { name } = …`, `const { key: local } = …`, and the multi-line form
  // `const {\n  name,\n} = …` with its trailing comma. A destructure of two or
  // more names has no single value to return, so it deliberately does not match.
  const objectSingle = /^\{\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?\s*,?\s*\}\s*=/.exec(rest);
  if (objectSingle?.[1]) return objectSingle[2] ?? objectSingle[1];

  // `const [first] = …`
  const arraySingle = /^\[\s*([A-Za-z_$][\w$]*)\s*\]\s*=/.exec(rest);
  if (arraySingle?.[1]) return arraySingle[1];

  return undefined;
}

/**
 * Lift a trailing *declaration* into a return.
 *
 * `splitTrailingExpression` recovers a trailing expression and `liftTrailingBlocks`
 * recovers one inside a trailing block, but a script ending in
 * `const { matches } = await tools.grep_search(...)` — a declaration, so not an
 * expression — fell through both and produced no value at all. The codemode
 * skill names this exact shape as "the single most common way to lose a result",
 * and it is the one the model keeps writing, which is why the "produced no
 * value" note kept firing even with the skill loaded.
 *
 * The rewrite does not move any of the model's code: the source runs exactly as
 * written, and a `return <name>;` is appended after it in the same function body
 * where the binding is in scope. Every candidate is compiled before use, so a
 * declaration this mis-reads (a multi-line destructure split at the wrong
 * boundary, say) is rejected rather than run.
 */
export function liftTrailingDeclaration(
  source: string,
  verify: (candidate: string) => boolean,
): string | undefined {
  const body = trimTail(source);
  if (body.trim().length === 0) return undefined;
  const boundaries = statementBoundaries(body);
  /*
   * Latest boundary first. For a single-line declaration the last boundary is
   * its start; for a multi-line one (`const {\n  matches,\n} = …`) the latest
   * boundary slices only the tail of it, which yields no binding, and the next
   * boundary up is the real start. Trying them newest-first finds the longest
   * suffix that reads as a whole declaration.
   */
  for (let i = boundaries.length - 1; i >= 0; i -= 1) {
    const statement = body.slice(boundaries[i]!.index);
    const name = declarationBinding(statement);
    if (!name) continue;
    // The source runs untouched; the return is appended on its own line so
    // none of the model's line numbers move.
    const candidate = `${DECL_LIFT_OPEN}${source}\n; return ${name}; })()`;
    if (verify(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The line the model's source occupies, from a position the engine reported.
 *
 * The `eval.js` filename is the QuickJS runtime's; the worker names itself
 * `codemode.js` and `node-runtime` parses its own stack traces, so this
 * function is retained only for the tests that still cover the transform in
 * isolation.
 *
 * Only meaningful because of the line-preserving construction above; with the
 * old shape this function would have needed to know which wrapper was used and
 * how many lines the prefix had, and would have been wrong for the tail.
 */
export function sourceLineFromStack(stack: string): number | undefined {
  const match = /eval\.js:(\d+):\d+/.exec(stack);
  if (!match?.[1]) return undefined;
  const line = Number(match[1]);
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

/*
 * A `looksLikeTopLevelAwait(message)` predicate lived here, and it was the
 * wrong shape for the problem. QuickJS reports top-level `await` as a bare
 * "expecting ';'" with no mention of the keyword, so matching on the message
 * never fired and every `await tools.x()` failed with a syntax error.
 *
 * The runtime now decides by *compiling* the rewritten form instead: if the
 * async wrapper compiles and the original did not, the difference is something
 * only a function body allows. That is a fact about the source rather than a
 * guess about a message, and it also rejects a wrapper that cannot help, so a
 * genuinely broken script still reports its own error at its own line.
 */
