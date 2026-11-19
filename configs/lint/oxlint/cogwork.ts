import { fileURLToPath } from "node:url";
import { defineConfig } from "oxlint";

export default defineConfig({
  // Oxlint rejects a relative jsPlugins path in a config that another config reaches through extends.
  jsPlugins: [fileURLToPath(new URL("../oxlint-plugin/index.ts", import.meta.url))],
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: { "cogwork/no-export-in-test": "error" },
    },
  ],
});
