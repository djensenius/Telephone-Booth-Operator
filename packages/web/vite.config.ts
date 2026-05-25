import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";

const buildDate =
  process.env.VITE_BUILD_DATE ??
  (process.env.NODE_ENV === "test" || process.env.VITEST === "true"
    ? "1970-01-01T00:00:00.000Z"
    : new Date().toISOString());

export default defineConfig({
  define: {
    "import.meta.env.VITE_BUILD_DATE": JSON.stringify(buildDate),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
    },
  },
});
