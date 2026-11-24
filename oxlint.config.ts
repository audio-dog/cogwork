import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "jsx-a11y", "vitest"],
  jsPlugins: ["./configs/lint/oxlint-plugin/index.ts"],
  categories: {
    correctness: "error",
  },
  options: {
    reportUnusedDisableDirectives: "error",
  },
  ignorePatterns: ["**/*.gen.ts", "configs/lint/tests/fixtures/**"],
  rules: {
    "cogwork/no-export-in-test": "error",
    "unicorn/filename-case": ["error", { case: "kebabCase" }],
    "react/refs": "off",
    "react/set-state-in-effect": "off",
    "react/static-components": "off",
    "vitest/expect-expect": "off",
    "vitest/no-conditional-expect": "off",
    "vitest/require-mock-type-parameters": "off",
    "vitest/require-to-throw-message": "off",
    "vitest/valid-expect": "off",
    "vitest/valid-title": "off",
  },
  overrides: [
    {
      files: ["**/routes/**"],
      rules: {
        "unicorn/filename-case": "off",
      },
    },
  ],
});
