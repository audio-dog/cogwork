// Imported by every package's vitest.config.ts rather than duplicated into it, so a setting
// cannot go missing from one package the way an explicit `include` already had. Vite bundles this
// beside the importing config, which is why `vitest/config` resolves here without this directory
// carrying a package.json of its own; nothing type-checks it, so keep it to plain configuration.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 excludes only node_modules and .git by default, so an unscoped pattern would
    // collect the desktop app's built output in out/ as tests. Sources are the only test home.
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
