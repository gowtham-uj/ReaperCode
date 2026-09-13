/**
 * The bridge from the model's JavaScript into Reaper's tools.
 *
 * There is exactly one decision in this file and everything else follows from
 * it: an inner call is not handled here at all, it is handed to
 * `ToolExecutor.execute` — the same public method the model's own tool calls go
 * through, on the same executor instance that is running this turn.
 *
 * That is the whole security story. Rather than re-deriving which checks apply
 * to a call made from inside eval, the call takes the identical path: alias
 * normalization, the disabled-tools refusal, schema validation, the sandbox and
 * role governance gate, the permission classifier, the approval request, the
 * PreToolUse hook, the dispatch, the PostToolUse hook, the workspace path
 * confinement inside each tool, the trajectory record, and the runtime events.
 * A second dispatcher would have to reproduce all of that and stay in step with
 * it forever; there is no version of that which is not eventually wrong.
 *
 * The consequences worth stating plainly:
 *
 * - Permissions are not weakened. A tool the thread switched off is refused
 *   inside eval with the same `TOOL_DISABLED` error the model would get
 *   outside it, because it is the same check. A tool needing approval raises
 *   an approval request from inside a script exactly as it would outside.
 * - Inner calls are visible. Each one emits `tool.started` / `tool.completed`
 *   and writes its own trajectory row, so an eval that made forty calls shows
 *   as forty tool executions plus the eval that contained them, rather than one
 *   opaque row.
 * - The surface is filtered by policy, not by convenience. `names()` returns
 *   what this agent may actually call, so the model is never offered a tool
 *   it would be refused for.
 */

import { toolRegistry, type ToolName } from "../registry.js";
import { ToolCallSchema, type ToolCall, type ToolResult } from "../types.js";
import { buildAgentToolDescriptor } from "../../runtime/agent-tools.js";
import type {
  CodeModelDescriptor,
  CodeModelInvocation,
  CodeModelOutcome,
  CodeToolDescriptor,
  CodeToolHost,
  CodeToolInvocation,
  CodeToolOutcome,
} from "./types.js";
import { canonicalToolName } from "../normalize.js";

/**
 * The one tool withheld from a script.
 *
 * `eval` is the cyclic case: a script calling itself nests one timeout budget
 * inside a runtime the level above cannot interrupt, so a model that wrote a
 * recursive eval would hang the turn with no way for anyone to see what it was
 * doing. Refusing it is what keeps the runtime's one guarantee — the turn comes
 * back — true for every script. That is the whole list, and it is deliberately
 * one entry long.
 *
 * `search_tools` is *not* withheld, and the argument for withholding it is
 * worth recording because it is superficially convincing: the tool exists to
 * reveal a deferred surface, this environment hands a script the whole surface,
 * so what would a call even do? The answer is that it does exactly what it does
 * outside — promotes a tool for the conversation — and that deciding it has no
 * purpose in here is a judgement about which tools are worth calling. This
 * environment does not make those; the model does.
 */
const WITHHELD_FROM_SCRIPTS: ReadonlySet<string> = new Set(["eval"]);


/** Runs one tool call through Reaper's normal path. */
export interface ToolInvoker {
  execute(call: ToolCall): Promise<ToolResult>;
}

/**
 * Runs one model call for a script's `models.call()`.
 *
 * A function rather than a gateway object because that is the whole of what the
 * bridge needs: the engine owns credential resolution, role routing and retry,
 * and this seam exists so the bridge does not have to know about any of them.
 * The engine supplies the closure; the bridge calls it and returns the text.
 */
export type CodeModelRunner = (invocation: CodeModelInvocation) => Promise<CodeModelOutcome>;

export interface CodeBridgeOptions {
  executor: ToolInvoker;
  /**
   * Names the thread switched off. Applied here as well as in the executor:
   * this list decides what the script is offered, and the executor decides
   * what it is allowed. Filtering on the offered side is what keeps the model
   * from being handed a name it can only fail on.
   */
  disabledTools?: ReadonlySet<string>;
  /**
   * The thread's chat models, when this run has any.
   *
   * Omitting both is what a test fixture does, and the result is that `models`
   * is not bound inside the script at all — a fixture never has to stub a
   * provider to exercise an eval that does not call one.
   */
  models?: readonly CodeModelDescriptor[];
  callModel?: CodeModelRunner;
}

export class ReaperToolBridge implements CodeToolHost {
  private readonly executor: ToolInvoker;
  private readonly disabledTools: ReadonlySet<string>;
  private readonly modelCatalogue: readonly CodeModelDescriptor[];
  private readonly modelRunner: CodeModelRunner | undefined;

  constructor(options: CodeBridgeOptions) {
    this.executor = options.executor;
    this.disabledTools = options.disabledTools ?? new Set<string>();
    this.modelCatalogue = options.models ?? [];
    this.modelRunner = options.callModel;
  }

  /**
   * The models a script may call, or nothing when this run has none.
   *
   * Returning `undefined` rather than an empty array is the signal the runtime
   * uses to leave `models` unbound. An empty array would bind the surface and
   * make `models.list()` return `[]`, which a script reads as "this thread has
   * no models configured" — a different and misleading answer from "this
   * environment does not lend you models at all".
   */
  async models(): Promise<readonly CodeModelDescriptor[] | undefined> {
    return this.modelRunner ? this.modelCatalogue : undefined;
  }

  async callModel(invocation: CodeModelInvocation): Promise<CodeModelOutcome> {
    if (!this.modelRunner) {
      return {
        ok: false,
        error: { code: "MODEL_NOT_EXPOSED", message: "This run has no model surface." },
        durationMs: 0,
      };
    }
    return this.modelRunner(invocation);
  }

  /**
   * Every tool this agent can call from inside a script.
   *
   * Derived from `toolRegistry` — the same source `CORE_TOOL_NAMES`,
   * `buildGeneralAgentTools` and `search_tools` read — so there is no second
   * registry to drift. A tool added to the registry appears here without
   * further work, and one removed disappears.
   *
   * Canonical names only, with the aliases accepted on the way in and left out
   * of this list. Two reasons: a script reading `tools.list()` should learn the
   * name the traces and the transcript will show, and `search_tools` reveals a
   * tool by its registry name, so a model that discovered `file_view` there and
   * looks for `read` here would be told the surface disagrees with itself.
   */
  names(): readonly string[] {
    return Object.keys(toolRegistry).filter((name) => this.canonicalName(name) === name);
  }

  describe(name: string): { description: string; inputSchema: unknown } | undefined {
    /*
     * Aliases resolve here for the same reason they resolve in `invoke`: a
     * script that called `tools.read` and got an answer must be able to ask
     * what `read` takes. Answering `undefined` for a name that works is a
     * stranger failure than not accepting the name at all.
     */
    const canonical = this.canonicalName(name);
    if (canonical === undefined) return undefined;
    const descriptor = buildAgentToolDescriptor(canonical);
    if (!descriptor) return undefined;
    return { description: descriptor.description, inputSchema: descriptor.inputSchema };
  }

  /** The catalogue the script's `tools.*` is initialised with. */
  catalogue(): CodeToolDescriptor[] {
    return this.names().flatMap((name) => {
      const entry = toolRegistry[name as ToolName];
      if (!entry) return [];
      return [{ name, description: entry.description }];
    });
  }

  async invoke(invocation: CodeToolInvocation): Promise<CodeToolOutcome> {
    /*
     * Re-checked here, not assumed from `names()`.
     *
     * The worker checks a name against its catalogue before it sends, but the
     * worker is the untrusted side of this boundary and its check is a
     * convenience, not a control: a script can replace `tools` with its own
     * Proxy, or post to the port directly, and reach `invoke` with a name that
     * was never offered. Rejecting it here means the only thing standing between a
     * crafted script and the registry is this method, which does not consult
     * anything the script can influence.
     */
    const canonical = this.canonicalName(invocation.name);
    if (canonical === undefined) {
      const refusal = this.refusalFor(invocation.name);
      return {
        ok: false,
        error: {
          code: refusal.code,
          message: `${refusal.message} Call tools.list() to see the tools you can use.`,
        },
        durationMs: 0,
      };
    }

    const candidate = { id: invocation.callId, name: canonical, args: invocation.args };
    const parsed = ToolCallSchema.safeParse(candidate);
    if (!parsed.success) {
      /*
       * Argument errors are returned rather than thrown, and the message keeps
       * Zod's field paths. A model that passed `{ pattern: "x" }` to a tool
       * wanting `{ query: "x" }` gets told which field it got wrong inside the
       * same eval call, instead of spending a round trip to be told.
       */
      return {
        ok: false,
        error: { code: "invalid_argument", message: formatIssues(parsed.error, canonical) },
        durationMs: 0,
        resolvedName: canonical,
      };
    }

    const started = Date.now();
    try {
      const result = await this.executor.execute(parsed.data as ToolCall);
      if (result.ok) {
        return { ok: true, output: result.output, durationMs: result.durationMs, resolvedName: canonical };
      }
      return {
        ok: false,
        error: {
          code: result.error?.code ?? "tool_error",
          /*
           * The name the script used, not the one it resolved to. A script that
           * asked for `tools.read` and got an error about `file_view` is being
           * told about a call it did not make — and on a failing call that is
           * the moment it is least equipped to work out why.
           */
          message: result.error?.message ?? `Tool '${invocation.name}' failed`,
        },
        durationMs: result.durationMs,
        resolvedName: canonical,
      };
    } catch (error) {
      /*
       * `execute` reports failures as results rather than exceptions, so
       * reaching here means the executor itself threw — a bug, or a hard
       * failure such as an approval that could not be requested. It is
       * reported to the script rather than propagated, because a thrown error
       * would abort the whole eval and discard whatever the script had already
       * gathered.
       */
      return {
        ok: false,
        error: {
          code: "executor_threw",
          message: error instanceof Error ? error.message : String(error),
        },
        durationMs: Date.now() - started,
        resolvedName: canonical,
      };
    }
  }

  /**
   * The registry key a script's name means, or `undefined` if it may not call it.
   *
   * The alias resolution is the reason this returns a name rather than a
   * boolean. `tools.read` has to become `file_view` somewhere, and doing it by
   * mutating the dictionary the worker builds would leave `tools.list()`
   * advertising names that are not what the tool is called.
   *
   * The withheld check comes *first*, before aliasing, and that order is the
   * whole reason it is a separate step. An alias is a name the model is invited
   * to use; if `eval` ever gained one, resolving first would turn the alias
   * table into a route around the recursion guard — the guard is checked
   * against the name as written, which is the name the script chose.
   */
  private canonicalName(name: string): string | undefined {
    if (WITHHELD_FROM_SCRIPTS.has(name)) return undefined;
    const canonical = canonicalToolName(name);
    if (WITHHELD_FROM_SCRIPTS.has(canonical)) return undefined;
    if (this.disabledTools.has(canonical)) return undefined;
    return Object.prototype.hasOwnProperty.call(toolRegistry, canonical) ? canonical : undefined;
  }

  /**
   * Why a name is not available, in the words that help most.
   *
   * Three reasons, and they need different answers. A name the registry has
   * never heard of is a typo or a hallucination and wants the real surface. A
   * tool the thread switched off is a real tool that this conversation is not
   * allowed to use, and saying "no such tool" would send a model hunting for a
   * spelling mistake that is not there. A withheld tool — `eval` itself — is
   * neither, and saying so plainly is the point: the alternative is a model
   * that concludes its recursion was merely misnamed.
   *
   * This distinction exists because the worker cannot make it. `tools.*` is
   * built from the surface, so an unavailable name is simply absent, a call to
   * it throws `not a function`, and the `catch` never sees a `code` — which is
   * exactly what an earlier version of this file left the model with.
   */
  /**
   * Why a call was refused, as the code *and* the sentence that explains it.
   *
   * The two travel together because they have to agree, and the failure mode
   * when they do not is the one this method exists to prevent. Returning prose
   * alone meant every refusal wore the same `TOOL_NOT_EXPOSED` code, so a
   * script that branched on `error.code` could not tell "this thread switched
   * that tool off" from "no such tool" — which is precisely the distinction the
   * message was written to draw. A model reading the sentence could tell them
   * apart; a model reading the code could not, and both are the same caller.
   *
   * The codes are the executor's own, so a refusal inside eval is
   * indistinguishable from the identical refusal outside it.
   */
  private refusalFor(name: string): { code: string; message: string } {
    if (WITHHELD_FROM_SCRIPTS.has(name) || WITHHELD_FROM_SCRIPTS.has(canonicalToolName(name))) {
      return {
        code: "TOOL_NOT_EXPOSED",
        message: `'${name}' is deliberately not available inside eval. A script cannot call itself.`,
      };
    }
    /*
     * Checked under both spellings, because the caller arrived here with one of
     * them and cannot be relied on to know which. A name switched off as
     * `file_view` also refuses `read` — anything else would let a script reach a
     * disabled tool by typing the alias, which is the shape of the bug this
     * whole resolution step is here to prevent.
     */
    if (this.disabledTools.has(name) || this.disabledTools.has(canonicalToolName(name))) {
      return {
        code: "TOOL_DISABLED",
        message: `'${name}' is switched off for this thread, so it cannot be called from inside eval either. Its configuration is in the thread's settings.`,
      };
    }
    return {
      code: "TOOL_NOT_EXPOSED",
      message: `There is no Reaper tool called '${name}'.`,
    };
  }
}

/** Turn Zod's issues into one sentence naming the offending fields. */
function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }, toolName: string): string {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
  return `Arguments for '${toolName}' are invalid — ${parts.join("; ")}. Call tools.describe("${toolName}") for the exact shape.`;
}
