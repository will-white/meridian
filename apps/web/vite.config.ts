import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { NAVIGATE_FALLBACK_DENYLIST } from "./src/lib/shellRoutes.js";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The page registers the worker itself (src/lib/swUpdate.ts): a new build waits until the
      // household chooses "Reload" in the shell's notice, so nothing being typed is lost, and the
      // open app checks for one on focus and hourly (audit b8-web-layout-09).
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "Meridian",
        short_name: "Meridian",
        description: "Self-hosted household finance",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        // The API is never cached: money data must always be live. Navigations to the API or to a
        // build file go to the server, which answers them as it does without a worker (a JSON
        // 404 rather than the shell; src/lib/shellRoutes.ts).
        navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
      },
    }),
  ],
  build: {
    rollupOptions: { output: { manualChunks: { echarts: ["echarts"] } } },
  },
  server: {
    port: 5173,
    // The API binds loopback (API_HOST). The Host header is passed through unchanged, which the
    // API's same-origin check for changes relies on.
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
