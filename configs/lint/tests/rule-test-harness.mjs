import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const lintRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot = path.join(lintRoot, "tests", "fixtures");
export const repoRoot = path.resolve(lintRoot, "../..");

const resolveBin = (packageName, binName) => {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const { bin } = require(packagePath);
  return path.resolve(path.dirname(packagePath), typeof bin === "string" ? bin : bin[binName]);
};

export const lintWithRule = (rulePath, fixturePath) => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "cogwork-lint-rule-"));
  const configPath = path.join(tempDirectory, "biome.json");
  writeFileSync(configPath, `${JSON.stringify({ plugins: [rulePath] }, null, 2)}\n`, "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [
        resolveBin("@biomejs/biome", "biome"),
        "lint",
        "--reporter=json",
        "--max-diagnostics=none",
        `--config-path=${configPath}`,
        fixturePath,
      ],
      { cwd: lintRoot, encoding: "utf8" },
    );

    return {
      diagnostics: JSON.parse(result.stdout).diagnostics,
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
};

export const lintWithOxlint = (config, fixturePaths) => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "cogwork-oxlint-rule-"));
  const configPath = path.join(tempDirectory, ".oxlintrc.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [resolveBin("oxlint", "oxlint"), "-A", "all", "-f", "json", "-c", configPath, ...fixturePaths],
      { cwd: lintRoot, encoding: "utf8" },
    );
    const diagnostics = JSON.parse(result.stdout).diagnostics;

    return {
      diagnosticsFor: (fixturePath) =>
        diagnostics.filter((diagnostic) => path.resolve(lintRoot, diagnostic.filename) === fixturePath),
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
};
