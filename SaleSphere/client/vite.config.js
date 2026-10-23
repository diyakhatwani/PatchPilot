
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
      },

      "/healthz": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
      },

      "/readyz": {
        target: "http://127.0.0.1:3101",
        changeOrigin: true,
      },

      "/patchpilot": {
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/patchpilot/, ""),
      },
    },
  },
});
