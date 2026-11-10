import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
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
        // The API is never cached: money data must always be live.
        navigateFallbackDenylist: [/^\/api\//],
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
