import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const lintRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(lintRoot, "tests", "fixtures");
const pluginPath = path.join(lintRoot, "oxlint-spike", "plugin.mjs");
const biomeConfigPath = path.join(lintRoot, "oxlint-spike", "biome-five.json");
const biomePackagePath = require.resolve("@biomejs/biome/package.json");
const biomeBin = path.resolve(path.dirname(biomePackagePath), require(biomePackagePath).bin.biome);
const oxlintPackagePath = require.resolve("oxlint/package.json");
const oxlintBin = path.resolve(path.dirname(oxlintPackagePath), require(oxlintPackagePath).bin.oxlint);

const lintWithRule = (name, fixturePath) => {
  const tempDirectory = mkdtempSync(path.join(tmpdir(), "cogwork-oxlint-rule-"));
  const configPath = path.join(tempDirectory, ".oxlintrc.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ jsPlugins: [pluginPath], rules: { [`cogwork/${name}`]: "error" } }, null, 2)}\n`,
    "utf8",
  );

  try {
    const result = spawnSync(oxlintBin, ["-A", "all", "-f", "json", "-c", configPath, fixturePath], {
      cwd: lintRoot,
      encoding: "utf8",
    });

    return {
      diagnostics: JSON.parse(result.stdout || '{ "diagnostics": [] }').diagnostics,
      output: `${result.stdout}${result.stderr}`,
      status: result.status ?? 1,
    };
  } finally {
    rmSync(tempDirectory, { force: true, recursive: true });
  }
};

const lintWithBiome = (fixturePath) => {
  const result = spawnSync(
    biomeBin,
    ["lint", "--reporter=json", "--max-diagnostics=none", `--config-path=${biomeConfigPath}`, fixturePath],
    { cwd: lintRoot, encoding: "utf8" },
  );

  return {
    diagnostics: JSON.parse(result.stdout).diagnostics,
    output: `${result.stdout}${result.stderr}`,
    status: result.status ?? 1,
  };
};

test("no-switch catches its prohibited pattern", () => {
  const result = lintWithRule("no-switch", path.join(fixtureRoot, "no-switch", "invalid-example.ts"));

  assert.equal(result.status, 1, result.output);
  assert.equal(result.diagnostics.length, 1, result.output);
});

test("no-switch allows its supported alternative", () => {
  const result = lintWithRule("no-switch", path.join(fixtureRoot, "no-switch", "valid-example.ts"));

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.diagnostics, [], result.output);
});

test("no-runtime-runfork catches its prohibited pattern", () => {
  const result = lintWithRule(
    "no-runtime-runfork",
    path.join(fixtureRoot, "no-runtime-runfork", "invalid-example.ts"),
  );

  assert.equal(result.status, 1, result.output);
  assert.equal(result.diagnostics.length, 1, result.output);
});

test("no-runtime-runfork allows its supported alternative", () => {
  const result = lintWithRule(
    "no-runtime-runfork",
    path.join(fixtureRoot, "no-runtime-runfork", "valid-example.ts"),
  );

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.diagnostics, [], result.output);
});

test("no-effect-sync-throw catches its prohibited pattern", () => {
  const result = lintWithRule(
    "no-effect-sync-throw",
    path.join(fixtureRoot, "no-effect-sync-throw", "invalid-example.ts"),
  );

  assert.equal(result.status, 1, result.output);
  assert.equal(result.diagnostics.length, 1, result.output);
});

test("no-effect-sync-throw allows its supported alternative", () => {
  const result = lintWithRule(
    "no-effect-sync-throw",
    path.join(fixtureRoot, "no-effect-sync-throw", "valid-example.ts"),
  );

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.diagnostics, [], result.output);
});

test("no-iife-wrapper catches its prohibited pattern", () => {
  const result = lintWithRule(
    "no-iife-wrapper",
    path.join(fixtureRoot, "no-iife-wrapper", "invalid-example.ts"),
  );

  assert.equal(result.status, 1, result.output);
  assert.equal(result.diagnostics.length, 1, result.output);
});

test("no-iife-wrapper allows its supported alternative", () => {
  const result = lintWithRule(
    "no-iife-wrapper",
    path.join(fixtureRoot, "no-iife-wrapper", "valid-example.ts"),
  );

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.diagnostics, [], result.output);
});

test("no-wire-union-tag-comparison catches its prohibited pattern", () => {
  const result = lintWithRule(
    "no-wire-union-tag-comparison",
    path.join(fixtureRoot, "no-wire-union-tag-comparison", "invalid-example.ts"),
  );

  assert.equal(result.status, 1, result.output);
  assert.equal(result.diagnostics.length, 1, result.output);
});

test("no-wire-union-tag-comparison allows its supported alternative", () => {
  const result = lintWithRule(
    "no-wire-union-tag-comparison",
    path.join(fixtureRoot, "no-wire-union-tag-comparison", "valid-example.ts"),
  );

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.diagnostics, [], result.output);
});

for (const name of [
  "no-switch",
  "no-runtime-runfork",
  "no-effect-sync-throw",
  "no-iife-wrapper",
  "no-wire-union-tag-comparison",
]) {
  test(`isolated Biome ${name} catches its prohibited pattern`, () => {
    const result = lintWithBiome(path.join(fixtureRoot, name, "invalid-example.ts"));

    assert.equal(result.status, 1, result.output);
    assert.equal(result.diagnostics.length, 1, result.output);
  });

  test(`isolated Biome ${name} allows its supported alternative`, () => {
    const result = lintWithBiome(path.join(fixtureRoot, name, "valid-example.ts"));

    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.diagnostics, [], result.output);
  });
}
