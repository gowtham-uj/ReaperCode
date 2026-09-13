import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@reaper/web-shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    // jsdom defaults to `about:blank`, whose opaque origin makes `localStorage`
    // undefined. The app runs on a real origin, so tests need one too — theme
    // persistence is untestable without it.
    environmentOptions: { jsdom: { url: "http://localhost/" } },
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    clearMocks: true,
    restoreMocks: true,
    // jsdom + user-event tests contend when Vitest runs component files in
    // parallel on small pods. Keep the assertions deterministic rather than
    // letting the framework's 5s default turn CPU contention into false fails.
    testTimeout: 15_000,
  },
});
