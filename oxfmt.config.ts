import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 110,
  useTabs: false,
  singleQuote: false,
  sortImports: true,
  sortTailwindcss: {
    stylesheet: "./packages/ui/src/styles/globals.css",
    functions: ["cn"],
  },
  sortPackageJson: true,
  ignorePatterns: ["**/*.gen.ts", "**/*.md", "**/*.yaml", "**/*.yml"],
});
