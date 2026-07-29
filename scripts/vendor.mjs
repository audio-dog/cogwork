#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EFFECT_REMOTE = "https://github.com/Effect-TS/effect.git";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reposDir = join(repoRoot, ".repos");
const target = join(reposDir, "effect");
const markerPath = join(target, ".vendored");

const require = createRequire(join(repoRoot, "packages/engine/package.json"));
const tag = `effect@${require("effect/package.json").version}`;

const alreadyVendored = existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === tag;
if (alreadyVendored) {
  console.log(`.repos/effect already pinned to ${tag}`);
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(reposDir, { recursive: true });

console.log(`Vendoring Effect source at ${tag} into .repos/effect …`);
execFileSync("git", ["clone", "--depth", "1", "--branch", tag, EFFECT_REMOTE, target], {
  stdio: "inherit",
});

writeFileSync(markerPath, `${tag}\n`);
console.log(`Done. .repos/effect pinned to ${tag}`);
