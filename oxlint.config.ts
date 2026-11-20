import { globSync } from "node:fs";

import { defineConfig, type OxlintConfig, type OxlintOverride } from "oxlint";

export type LintArea = Required<Pick<OxlintOverride, "files" | "rules">>;

const defaultExports = <T>(pattern: string) =>
  Promise.all(
    globSync(pattern, { cwd: import.meta.dirname })
      .toSorted()
      .map(async (file): Promise<T> => (await import(`./${file}`)).default),
  );

const [configs, areas] = await Promise.all([
  defaultExports<OxlintConfig>("configs/lint/oxlint/*.ts"),
  defaultExports<LintArea>("configs/lint/areas/*.ts"),
]);

export default defineConfig({
  extends: configs,
  ignorePatterns: ["**/*.gen.ts", "configs/lint/tests/fixtures/**"],
  overrides: areas,
});
