import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@clanker-forge/contracts"] },
    },
  },
  preload: {},
  renderer: {
    plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  },
});
