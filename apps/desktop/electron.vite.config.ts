import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@clanker-forge/contracts"] },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
