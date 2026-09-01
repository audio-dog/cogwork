import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const lintRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot = path.join(lintRoot, "tests", "fixtures");
export const repoRoot = path.resolve(lintRoot, "../..");

const resolveBiomeBin = () => {
  const packagePath = require.resolve("@biomejs/biome/package.json");
  const biomePackage = require(packagePath);
  const bin = typeof biomePackage.bin === "string" ? biomePackage.bin : biomePackage.bin.biome;
  return path.resolve(path.dirname(packagePath), bin);
};

export const lintWithRule = (ruleName, fixturePath) => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "cogwork-lint-rule-"));
  const configPath = path.join(tempDirectory, "biome.json");
  const rulePath = path.join(lintRoot, `${ruleName}.grit`);
  writeFileSync(configPath, `${JSON.stringify({ plugins: [rulePath] }, null, 2)}\n`, "utf8");

  try {
    const result = spawnSync(
      process.execPath,
      [
        resolveBiomeBin(),
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
