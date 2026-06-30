import type { ReaperExtensionContext } from "reaper";
import { echoHandler } from "./tools/echo.js";

export default {
  activate(ctx: ReaperExtensionContext): void {
    // 1. Register a tool. The metadata object is REQUIRED.
    ctx.registerTool({
      name: "hello.echo",
      description: "Echo a string back to the model",
      schema: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      metadata: {
        name: "hello.echo",
        category: "read",
        risk_level: "low",
        is_read_only: true,
        can_modify_files: false,
        can_execute_code: false,
        can_control_ui: false,
        can_affect_host: false,
        requires_approval: false,
        preferred_before: [],
        preferred_after: [],
        forbidden_in_roles: [],
        allowed_in_roles: ["explorer", "architect", "implementer", "test", "reviewer", "critic", "browser", "root"],
      },
      handler: echoHandler,
    });

    // 2. Register a slash command.
    ctx.registerSlashCommand({
      name: "hello",
      description: "Say hello from an extension",
      handler: () => ({ ok: true, output: "Hello from the example extension!" }),
    });

    // 3. Register a PreToolUse hook with a 2s timeout.
    ctx.registerHook({
      event: "PreToolUse",
      handler: (env) => {
        ctx.log.info(`pre-tool-use: ${env.event}`);
        return { allow: true };
      },
      timeoutMs: 2000,
    });
  },
  deactivate(): void {
    // no-op
  },
};
