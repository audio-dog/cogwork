import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "./rule-test-harness.mjs";

// `no-use-effect.grit` stays scoped to current React packages to avoid a repository-wide Biome pass.
// Widen its biome.json override when another package adopts React.
test("the react plugin's scope covers every file that imports React", () => {
  const biomeConfig = JSON.parse(readFileSync(path.join(repoRoot, "biome.json"), "utf8"));
  const reactOverride = biomeConfig.overrides.find((override) =>
    override.plugins?.some((plugin) => plugin.endsWith("no-use-effect.grit")),
  );
  const scopedPrefixes = reactOverride.includes.map((include) => include.replace(/\*+$/, ""));

  const tracked = spawnSync("git", ["ls-files", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .stdout.split("\n")
    .filter(Boolean)
    .filter((file) => !file.startsWith("configs/lint/tests/fixtures/"));
  const importsReact = tracked.filter((file) =>
    /\bfrom\s+["']react["']/.test(readFileSync(path.join(repoRoot, file), "utf8")),
  );
  const unscoped = importsReact.filter((file) => !scopedPrefixes.some((prefix) => file.startsWith(prefix)));

  assert.notEqual(importsReact.length, 0, "expected to find files importing React");
  assert.deepEqual(unscoped, []);
});
