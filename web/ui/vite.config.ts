import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const BFF_TARGET = process.env.REAPER_BFF_URL ?? "http://127.0.0.1:4180";

export default defineConfig({
  // Anchored to this file, not the cwd, so `vite --config web/ui/vite.config.ts`
  // works when run from the repo root.
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [solid()],
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
    // The BFF is proxied rather than exposed. One published origin, and the
    // BFF itself never has to leave loopback.
    proxy: {
      "/ws": { target: BFF_TARGET, ws: true },
      "/api": { target: BFF_TARGET },
      "/healthz": { target: BFF_TARGET },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
