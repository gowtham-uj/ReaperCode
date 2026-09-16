import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BFF_TARGET = process.env.REAPER_BFF_URL ?? "http://127.0.0.1:4180";

export default defineConfig({
  // Anchored to this file, not the cwd, so `vite --config web/ui/vite.config.ts`
  // works when run from the repo root.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@reaper/web-shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    // Loopback by default. The app-server runs without an auth token, so
    // reachability is the entire access control. REAPER_WEB_HOST=0.0.0.0 opts
    // into a wider bind for `reaper-port publish`, where the published route
    // carries Reaper auth — that auth is then what replaces loopback.
    host: process.env.REAPER_WEB_HOST ?? "127.0.0.1",
    port: 5273,
    /*
     * No CORS, on any route.
     *
     * Vite's dev server reflects the request's Origin back as
     * `Access-Control-Allow-Origin` by default, and it does that for the dev
     * server's own routes as well as for the proxied ones. `foo.localhost`
     * counts as loopback, so a page served from any `*.localhost` origin could
     * read `/api/file?path=.env` through this port and get the provider keys
     * verbatim. Verified.
     *
     * The UI is same-origin with this server, so it needs no header, and a
     * foreign page that gets none is blocked by the browser. Setting it here
     * rather than per-proxy-rule because the reflection happened on the routes
     * that are *not* proxied too.
     */
    cors: false,
    // The BFF is proxied rather than exposed. One published origin, and the
    // BFF itself never has to leave loopback.
    proxy: {
      "/ws": { target: BFF_TARGET, ws: true },
      /*
       * `ws: true` on `/api`, not just `/ws`.
       *
       * The live browser pane's stream is a websocket under `/api/live/...`, and
       * a proxy rule without `ws` drops the upgrade: the browser reports "closed
       * before the connection was established" and Steel's viewer sits on
       * "Session connecting" forever. Reproduced by comparing the two paths
       * directly: `ws://127.0.0.1:4180/api/live/<thread>?tabInfo=true` returns a
       * tab list, and the same URL through the Vite port fails the handshake.
       *
       * `cors: false` as well, because the dev server's default is to reflect
       * any Origin back as `Access-Control-Allow-Origin`. That made a page on
       * any loopback origin able to read `/api/*` through this port, including
       * provider keys from `.env`. The UI is same-origin with its own dev
       * server, so it needs no ACAO; a foreign page now gets none and the
       * browser blocks the read.
       */
      "/api": { target: BFF_TARGET, ws: true, cors: false },
      "/healthz": { target: BFF_TARGET },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
