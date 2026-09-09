import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 excludes only node_modules and .git by default, so tests must stay scoped to sources.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
