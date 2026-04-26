import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7878,
    strictPort: true,
    host: "127.0.0.1",
    open: process.env.OPEN_BROWSER === "1",
    proxy: {
      "/api": "http://127.0.0.1:7777",
      "/ws": { target: "ws://127.0.0.1:7777", ws: true },
    },
  },
});
