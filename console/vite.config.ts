import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// API base URL — injected at build time via VITE_API_BASE_URL.
// On Render this is https://stoat-api.onrender.com (set in the Blueprint).
// Locally it defaults to http://localhost:3000.
const apiBase = process.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  // Root must point to the console/ directory where index.html lives
  root: __dirname,
  build: {
    outDir: resolve(__dirname, "../dist/console"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // CONSOLE_URL and PayPal return links expect this port. Fail clearly if it is taken
    // instead of silently moving to 5174.
    strictPort: true,
    proxy: {
      // Proxy /v1 to the API server during local development
      "/v1": {
        target: apiBase,
        changeOrigin: true,
      },
    },
  },
});
