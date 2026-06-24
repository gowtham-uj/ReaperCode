/**
 * hello.echo tool — returns the input message back to the model.
 * The metadata object lives in echo.metadata.ts so the install
 * pipeline can register it before activation.
 */
import type { ExtensionToolHandler } from "reaper";

export const echoHandler: ExtensionToolHandler = async (args) => {
  const msg = typeof args.msg === "string" ? args.msg : "";
  return { ok: true, output: msg };
};
