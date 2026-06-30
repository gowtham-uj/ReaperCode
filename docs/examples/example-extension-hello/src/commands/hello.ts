/**
 * /hello slash command handler. Registered via
 * `ctx.registerSlashCommand` in activate.ts.
 */
import type { SlashCommandHandler } from "reaper";

export const helloCommand: SlashCommandHandler = () => ({
  ok: true,
  output: "Hello from the example extension!",
});
