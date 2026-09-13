/**
 * Dev entrypoint: starts the app-server with the browser gateway mounted in
 * the same process, then prints the URLs. The Vite dev server runs separately
 * (`npm run web:ui`).
 *
 * One process, two loopback listeners: the raw app-server protocol (a random
 * port) and the browser gateway (REAPER_BFF_PORT, default 4180). The gateway
 * is what Vite proxies `/ws`, `/api`, and `/healthz` to.
 */

import { startAppServer } from "../src/app-server/server.js";

const workspaceRoot = process.env.REAPER_WORKSPACE ?? process.cwd();
const gatewayPort = Number(process.env.REAPER_BFF_PORT ?? 4180);

const appServer = await startAppServer({
  workspaceRoot,
  listen: "ws://127.0.0.1:0",
  web: {
    host: "127.0.0.1",
    port: gatewayPort,
  },
});

process.stdout.write(
  `app-server  ${appServer.ready.url}\n`
  + `gateway     ${appServer.web?.url ?? "(not mounted)"}\n`
  + `workspace   ${workspaceRoot}\n\n`
  + `Now run:    npm run web:ui\n`,
);

const shutdown = async (): Promise<void> => {
  await appServer.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
