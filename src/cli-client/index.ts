/**
 * The CLI's client for the app-server.
 *
 * `reaper exec run` used to drive the agent directly, with its own provider
 * setup and its own output path. That meant every behaviour had two
 * implementations, and they drifted: the CLI printed the model's reasoning
 * interleaved into its answer, unlabelled, because the two travelled the same
 * untyped stdout channel. The web UI never had that bug, because it reads a
 * typed event stream from the app-server.
 *
 * So the CLI became a client of that same server. `runTurn` below is the one
 * entry point; whether the server is in this process or across a socket is a
 * transport detail that nothing above this module sees.
 */
export { createCliClient, JsonRpcError } from "./client.js";
export type { CliTurnRequest, CliTurnResult, CliClientHandle } from "./client.js";
export { connectInProcess, InProcessConnection } from "./connection.js";
export { connectRemote } from "./remote.js";
export type { RemoteClient, RemoteClientOptions } from "./remote.js";
