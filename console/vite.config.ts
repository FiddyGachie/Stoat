import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API base URL — injected at build time via VITE_API_BASE_URL.
// On Render this is https://stoat-api.onrender.com (set in the Blueprint).
// Locally it defaults to http://localhost:3000.
const apiBase = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "../dist/console",
    emptyOutDir: true,
  },
  define: {
    // Makes the API base URL available at runtime in the console bundle.
    // Usage in code: import.meta.env.VITE_API_BASE_URL
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy /v1 to the API server during local development
      "/v1": {
        target: apiBase,
        changeOrigin: true,
      },
    },
  },
});
