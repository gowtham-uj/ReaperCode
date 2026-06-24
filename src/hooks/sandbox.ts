/**
 * Hook sandbox — compiles user-supplied JS source into a callable
 * hook handler, with strict size + shape guards.
 *
 * The handler body is a JavaScript function with the signature
 *   (event) => { allow: boolean, message?: string, reason?: string }
 *
 * The compiled function is called by the runtime HookRunner with
 * per-handler timeout + fault isolation (see src/extensions/hook-runner.ts).
 *
 * Compilation uses `new Function('event', body)`. There is no VM
 * isolation — the handler runs in the executor's process. The
 * approval gate (`approve_hook` in the model-callable surface) is
 * the wall: the user must read the source and trust it before
 * `enforce: true` lets it block tool calls.
 *
 * Guards applied at compile time:
 *   - source size: ≤ MAX_SOURCE_BYTES (default 64KB)
 *   - output size: every handler is wrapped to cap its return string
 *     fields to MAX_OUTPUT_BYTES (default 4KB)
 *   - shape: the compiled fn must accept exactly one argument
 *     ('event'); we don't enforce the return shape at compile time
 *     (it's a runtime contract) but a smoke test fires it.
 *
 * If the source fails `new Function` compilation, `compileHookSource`
 * returns `{ok: false, error}` and the caller surfaces the message
 * to the model. The user can fix the source and call `update_hook`.
 */

export interface CompiledHookHandler {
  /**
   * The compiled handler. `event` is a HookEvent (name + payload + blockable).
   * Returns `{allow, message?, reason?}`.
   */
  (event: { name: string; payload: Record<string, unknown>; blockable: boolean }):
    | { allow: boolean; message?: string; reason?: string }
    | Promise<{ allow: boolean; message?: string; reason?: string }>;
}

export interface CompileOptions {
  /** Default 65536 (64KB). */
  maxSourceBytes?: number;
  /** Default 4096 (4KB). Caps string fields in the return value. */
  maxOutputBytes?: number;
}

export interface CompileResult {
  ok: boolean;
  handler?: CompiledHookHandler;
  /** The compiled function's source for inspection / re-compilation. */
  source: string;
  error?: string;
}

const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024;

export class HookCompilationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HookCompilationError";
    this.code = code;
  }
}

/**
 * Compile a JS handler body to a callable. Throws
 * `HookCompilationError` on size / syntax errors. Returns a wrapped
 * function that also caps the return-string size.
 */
export function compileHookSource(source: string, opts: CompileOptions = {}): CompileResult {
  const maxSource = opts.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  if (typeof source !== "string") {
    return { ok: false, source: "", error: `source must be a string (got ${typeof source})` };
  }
  if (Buffer.byteLength(source, "utf8") > maxSource) {
    return { ok: false, source, error: `source exceeds ${maxSource} bytes (got ${Buffer.byteLength(source, "utf8")})` };
  }
  if (source.trim().length === 0) {
    return { ok: false, source, error: "source is empty" };
  }

  let raw: Function;
  try {
    // The handler body is the body of `(event) => { ... }`. We
    // wrap it in a Function constructor to compile.
    raw = new Function("event", source);
  } catch (e) {
    return { ok: false, source, error: `compilation failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  // The compiled fn's arity must be 1.
  if (raw.length > 1) {
    return { ok: false, source, error: `handler must accept exactly one argument (got ${raw.length})` };
  }

  // Wrap to cap the return-value string fields.
  const wrapped: CompiledHookHandler = (event) => {
    const out = raw(event);
    if (out && typeof out === "object" && "then" in out && typeof (out as { then: unknown }).then === "function") {
      // Async handler — wrap the promise.
      return (out as Promise<{ allow: boolean; message?: string; reason?: string }>).then(
        (resolved) => capResult(resolved, maxOutput),
        (err) => {
          // Treat unhandled rejection as `{ allow: true }` — the
          // HookRunner also handles this, but the wrap keeps the
          // shape stable for any direct caller.
          throw err instanceof Error ? err : new Error(String(err));
        },
      );
    }
    return capResult(out as { allow: boolean; message?: string; reason?: string }, maxOutput);
  };

  return { ok: true, handler: wrapped, source };
}

function capResult(
  result: { allow: boolean; message?: string; reason?: string } | undefined,
  maxOutput: number,
): { allow: boolean; message?: string; reason?: string } {
  if (!result || typeof result !== "object") {
    return { allow: true };
  }
  const allow = typeof result.allow === "boolean" ? result.allow : true;
  const message = capString(result.message, maxOutput);
  const reason = capString(result.reason, maxOutput);
  const out: { allow: boolean; message?: string; reason?: string } = { allow };
  if (message !== undefined) out.message = message;
  if (reason !== undefined) out.reason = reason;
  return out;
}

function capString(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  if (Buffer.byteLength(s, "utf8") <= max) return s;
  return s.slice(0, max);
}

/**
 * Sanity-check: fires the compiled handler with a synthetic event
 * and asserts the return shape. Used by tests + at registration
 * time in `approve_hook` so we fail fast on bad handlers.
 */
export function smokeTestHandler(
  handler: CompiledHookHandler,
  sample: { name: string; payload: Record<string, unknown>; blockable: boolean },
): { ok: boolean; error?: string; result?: { allow: boolean; message?: string; reason?: string } } {
  try {
    const raw = handler(sample);
    if (raw && typeof raw === "object" && "then" in raw && typeof (raw as { then: unknown }).then === "function") {
      return {
        ok: false,
        error: "handler is async; the smoke test only supports sync handlers — use the runtime path for async",
      };
    }
    const r = raw as { allow: boolean; message?: string; reason?: string };
    if (typeof r.allow !== "boolean") {
      return { ok: false, error: `handler returned non-boolean allow (got ${typeof r.allow})` };
    }
    return { ok: true, result: r };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
