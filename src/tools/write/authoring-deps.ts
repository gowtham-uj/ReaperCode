/**
 * tools/write/authoring-deps.ts — build the dependencies the three authoring
 * manager tools need, from nothing but a workspace root and a user home.
 *
 * `skill_manager`, `extension_manager`, and `hook_manager` are dispatched by the
 * executor through `ToolExecutorOptions.authoringTools`. The handlers themselves
 * were written and tested, and the executor switch that calls them was written
 * and tested — but nothing supplied the option. The wiring landed in the same
 * commit that introduced it and was never connected, so all three tools threw
 * "not wired for this run" on every call, in every run, since they were added.
 *
 * Nothing caught it because every layer was independently correct: the schema
 * parsed, the promotion path worked, the handler worked when a test built its
 * deps by hand. What was missing was the one caller that joins them, and no
 * test stood at that join. A live sweep did: the model searched for each tool,
 * received its schema, called it, and got the error back.
 *
 * The builders live here rather than inline in the engine for the same reason
 * the handlers live in their own modules: this is the unit a test can exercise
 * without constructing a whole runtime.
 *
 * Construction reads directories, so it is deferred until a manager tool is
 * actually called. A run that never authors a skill should not walk two skill
 * trees and an extension directory to find that out.
 */

import { join } from "node:path";

import { discoverSkills } from "../../skills/discovery.js";
import { SkillLifecycle } from "../../skills/lifecycle.js";
import { SkillRegistry } from "../../skills/registry.js";
import { TrustResolver } from "../../skills/trust.js";
import { builtinSkillsRoot } from "../../skills/built-in/index.js";
import { ExtensionLifecycle } from "../../extensions/lifecycle.js";
import { ExtensionRegistry } from "../../extensions/registry.js";
import { HookLifecycle } from "../../hooks/lifecycle.js";
import { HookRunner } from "../../extensions/hook-runner.js";
import { SkillMemoryRegistry } from "../../adaptive/skill-memory-registry.js";
import { TOOL_METADATA } from "../../governance/tool-metadata.js";

import type { AuthoringToolDeps } from "../executor.js";
import type { ToolApprovalRequester } from "../approval.js";
import type { PermissionMode } from "../../policy/classifier.js";
import { handleSkillManager } from "./skill-tools.js";
import { handleExtensionManager } from "./extension-tools.js";
import type { ExtensionToolRegistry } from "../../extensions/tool-registry.js";
import { handleHookManager } from "./hook-tools.js";

export interface AuthoringRuntimeInput {
  workspaceRoot: string;
  userHome: string;
  /** The live skill registry the runtime already consults, when there is one. */
  skillMemory?: SkillMemoryRegistry;
  /** The live hook runner the runtime already emits through, when there is one. */
  hookRunner?: HookRunner;
  /**
   * How the run asks the user to approve something.
   *
   * Threaded here because creating or enabling an extension executes code with
   * Reaper's own privileges, and the control for that is consent rather than
   * confinement: an extension is a plugin, so it runs in-process by design, and
   * the only thing standing between a model and arbitrary code execution as the
   * host is the user being asked. Without this the gates on `create` and `enable`
   * are inert — they check a requester that was never supplied.
   *
   * Optional because tests and direct construction legitimately build these
   * handlers without an approval surface; when it is absent the gates are
   * skipped rather than every call failing.
   */
  approvalRequester?: ToolApprovalRequester | undefined;
  /** Identity for the approval request, when there is a requester. */
  runId?: string | undefined;
  sessionId?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  abortSignal?: AbortSignal | undefined;
}

/**
 * Deferred, memoised authoring dependencies.
 *
 * Every accessor builds on first call and then returns the same instance. That
 * matters for `hook_manager`: `HookLifecycle.discover()` registers approved
 * hooks on the runner, so a second lifecycle over the same runner would
 * register every hook twice and each tool call would fire its handlers twice.
 *
 * A failed construction is remembered as the error, not retried on every call.
 * A missing extensions directory is a stable fact about the workspace, and
 * re-walking it per call would turn one clear message into one per turn.
 */
export class AuthoringRuntime {
  private skillDeps: { deps: unknown } | { error: Error } | undefined;
  private extensionDeps: { deps: unknown } | { error: Error } | undefined;
  private hookDeps: { deps: unknown } | { error: Error } | undefined;

  constructor(private readonly input: AuthoringRuntimeInput) {}

  /**
   * Build the `authoringTools` option the executor expects.
   *
   * Each manager is wrapped so that a construction failure surfaces as a
   * thrown Error naming the tool and the cause — the executor turns a throw
   * into a `tool_error` result, which is what the model can act on. Returning
   * `undefined` for a manager that could not be built would instead produce the
   * "not wired for this run" message, which is the exact defect this module
   * exists to remove: it tells the model the feature is absent when the truth
   * is that this workspace's copy of it could not be read.
   */
  build(): AuthoringToolDeps {
    return {
      handleSkillManager: (args: unknown) => {
        const deps = this.skills();
        if ("error" in deps) throw deps.error;
        return handleSkillManager(args as never, deps.deps as never);
      },
      handleExtensionManager: (args: unknown) => {
        const deps = this.extensions();
        if ("error" in deps) throw deps.error;
        return handleExtensionManager(args as never, deps.deps as never);
      },
      handleHookManager: (args: unknown) => {
        const deps = this.hooks();
        if ("error" in deps) throw deps.error;
        return handleHookManager(args as never, deps.deps as never);
      },
    };
  }

  /**
   * The extension registry this runtime built, for the executor to dispatch
   * from.
   *
   * The registry is constructed lazily by `extensions()` and, until this
   * existed, stayed private: the executor had no way to reach it, so an
   * extension's tools could be registered and activated and never dispatched.
   * Building it here — rather than having the engine construct a second one —
   * is what keeps the tools the manager activates and the tools the executor
   * calls the same set, which is the property that was missing.
   *
   * Returns `undefined` when the registry could not be built, so a workspace
   * whose extensions directory is unreadable degrades to "no extension tools"
   * instead of failing the run that asked for one.
   */
  extensionToolRegistry(): ExtensionToolRegistry | undefined {
    return this.extensionRegistry()?.getToolRegistry();
  }

  /**
   * The extension manager itself, for `installExtensionTools`.
   *
   * It needs the manager — not just the tool registry — because it walks each
   * enabled extension's declared permissions and status to decide what may be
   * copied. Handing it the tool registry alone would lose the trust check that
   * keeps an untrusted project's tools out of dispatch.
   */
  extensionRegistry(): ExtensionRegistry | undefined {
    const built = this.extensions();
    if ("error" in built) return undefined;
    return (built.deps as { registry?: ExtensionRegistry }).registry;
  }

  private skills(): { deps: unknown } | { error: Error } {
    if (this.skillDeps) return this.skillDeps;
    this.skillDeps = attempt("skill_manager", () => {
      const { workspaceRoot, userHome } = this.input;
      const memory =
        this.input.skillMemory ?? new SkillMemoryRegistry({ workspaceRoot, userHome });
      // The registry validates skill manifests against the tool metadata the
      // runtime actually ships, so a skill that declares a tool that does not
      // exist is refused at create time rather than at activation. Passing an
      // empty record here would silently disable that check.
      const registry = new SkillRegistry({ builtinMetadata: TOOL_METADATA, memory });
      const builtinRoot = builtinSkillsRoot();
      // One resolver instance for both the discovery walk and the lifecycle:
      // it caches trust decisions per path, and two instances would each read
      // the same trust.json off disk.
      const resolver = new TrustResolver({
        builtinRoot,
        userHomeSkillsDir: join(userHome, ".reaper", "skills"),
        projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
      });

      /*
       * Register whatever is already installed before handing the registry to
       * the lifecycle. `create` writes a new skill and registers it, but
       * `approve`/`uninstall`/`test` all act on skills that were installed
       * earlier — by a previous run, or by hand. Without this walk the manager
       * would report every pre-existing skill as missing, which is the same
       * class of wrong answer as the "not wired" message: a confident statement
       * about a feature that was never consulted.
       */
      try {
        const discovered = discoverSkills({
          builtinRoot,
          userHomeSkillsDir: join(userHome, ".reaper", "skills"),
          projectSkillsDir: join(workspaceRoot, ".reaper", "skills"),
          workspaceRoot,
          resolver,
        });
        for (const record of discovered.records) registry.register(record);
      } catch {
        // An unreadable skills tree must not stop the manager from running:
        // `create` into a fresh workspace is the most common case, and it does
        // not need anything on disk. Discovery is best-effort here, and the
        // lifecycle reports per-skill "not found" if something is missing.
      }

      return {
        lifecycle: new SkillLifecycle({
          registry,
          memory,
          resolver,
          workspaceRoot,
          userHome,
          builtinRoot,
          /*
           * No `runCommand` override. `SkillLifecycle`'s own default is the same
           * sandboxed runner this file used to pass, so the override was a
           * second copy of one boundary and the two had to be kept in step by
           * hand. Deleting it means the app-server, the CLI and any future
           * caller all get the same confinement by construction.
           */
        }),
        registry,
      };
    });
    return this.skillDeps;
  }

  private extensions(): { deps: unknown } | { error: Error } {
    if (this.extensionDeps) return this.extensionDeps;
    this.extensionDeps = attempt("extension_manager", () => {
      const { workspaceRoot, userHome } = this.input;
      const registry = new ExtensionRegistry({
        workspaceRoot,
        userHome,
        builtinRoot: join(workspaceRoot, ".reaper", "extensions-builtin"),
        ...(this.input.hookRunner ? { hookRunner: this.input.hookRunner } : {}),
      });
      // `create` needs the install dirs to exist; `discover` is idempotent and
      // the handler calls it again before every action, so doing it once here
      // only means the first `list` has something to return.
      registry.discover();
      return {
        lifecycle: new ExtensionLifecycle(registry),
        registry,
        workspaceRoot,
        userHome,
        ...(this.approvalGate() ? { approvalRequester: this.approvalGate() } : {}),
      };
    });
    return this.extensionDeps;
  }

  /**
   * The approval adapter the extension handlers call.
   *
   * The executor's requester speaks in whole `ToolCall`s, because that is what
   * its own gate has when a tool needs approving. These handlers know which
   * action is asking, not which call it arrived in, so the request is built here
   * with that action as the reason — which is exactly the sentence a user needs
   * to decide: "an extension wants to write and run code in this process".
   *
   * Returns undefined when the run has no approval surface, so a test or a
   * direct caller is not blocked by a gate it cannot satisfy.
   */
  private approvalGate(): ((input: { kind: string; id: string; description: string; trust: string }) => Promise<boolean>) | undefined {
    const requester = this.input.approvalRequester;
    if (!requester) return undefined;
    return async (input) => {
      const decision = await requester.requestApproval(
        {
          approvalId: `extension-${input.kind}-${input.id}`,
          runId: this.input.runId ?? "unknown",
          sessionId: this.input.sessionId ?? "unknown",
          toolCall: { id: `extension-${input.id}`, name: "extension_manager", args: { action: "enable", id: input.id } },
          workspaceRoot: this.input.workspaceRoot,
          workingDirectory: this.input.workspaceRoot,
          permissionMode: this.input.permissionMode ?? "strict",
          reason:
            `An extension is about to ${input.kind === "create_extension" ? "be written" : "run"} in Reaper's own process ` +
            `with Reaper's privileges (${input.id}: ${input.description}). Extensions are not sandboxed.`,
        },
        this.input.abortSignal,
      );
      return decision === "approved";
    };
  }

  private hooks(): { deps: unknown } | { error: Error } {
    if (this.hookDeps) return this.hookDeps;
    this.hookDeps = attempt("hook_manager", () => ({
      lifecycle: new HookLifecycle({
        runner: this.input.hookRunner ?? new HookRunner(),
        workspaceRoot: this.input.workspaceRoot,
        userHome: this.input.userHome,
      }),
    }));
    return this.hookDeps;
  }
}

function attempt(label: string, build: () => unknown): { deps: unknown } | { error: Error } {
  try {
    return { deps: build() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: new Error(`${label} could not be initialised: ${detail}`) };
  }
}
