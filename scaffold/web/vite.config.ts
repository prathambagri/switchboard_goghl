import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const server = "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: server,
        changeOrigin: true,
      },
      "/auth": {
        target: server,
        changeOrigin: true,
      },
      "/healthz": {
        target: server,
        changeOrigin: true,
      },
      "/ws": {
        target: server,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
