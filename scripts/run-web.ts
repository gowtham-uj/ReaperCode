/**
 * Dev entrypoint: starts an app-server and the BFF in one process, then prints
 * the URLs. The Vite dev server runs separately (`npm run web:ui`).
 *
 * The app-server binds loopback with no auth token, which `assertSafeListener`
 * permits. That means reachability is the access control, so the BFF binds
 * loopback too.
 */

import { startAppServer } from "../src/app-server/server.js";
import { startBff } from "../web/bff/src/server.js";

const workspaceRoot = process.env.REAPER_WORKSPACE ?? process.cwd();
const bffPort = Number(process.env.REAPER_BFF_PORT ?? 4180);

const appServer = await startAppServer({
  workspaceRoot,
  listen: "ws://127.0.0.1:0",
});

const bff = await startBff({
  appServerUrl: appServer.ready.url,
  ...(process.env.REAPER_APP_SERVER_TOKEN ? { appServerToken: process.env.REAPER_APP_SERVER_TOKEN } : {}),
  host: "127.0.0.1",
  port: bffPort,
  workspaceRoot,
});

process.stdout.write(
  `app-server  ${appServer.ready.url}\n`
  + `bff         ${bff.url}\n`
  + `workspace   ${workspaceRoot}\n\n`
  + `Now run:    npm run web:ui\n`,
);

const shutdown = async (): Promise<void> => {
  await bff.close();
  await appServer.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
