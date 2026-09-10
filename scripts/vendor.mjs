#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const reposDir = join(repoRoot, ".repos");
const require = createRequire(join(repoRoot, "packages/engine/package.json"));

const pinnedEffectTag = () => `effect@${require("effect/package.json").version}`;

const REPOS = [
  {
    name: "effect",
    remote: "https://github.com/Effect-TS/effect.git",
    ref: pinnedEffectTag,
    refIsBranch: true,
  },
  { name: "opencode", remote: "https://github.com/anomalyco/opencode.git" },
  { name: "codex", remote: "https://github.com/openai/codex.git" },
  {
    name: "biome-effect-linting-rules",
    remote: "https://github.com/OperationalFallacy/biome-effect-linting-rules.git",
  },
];

const git = (args, opts) => execFileSync("git", args, { encoding: "utf8", ...opts });

const headSha = (remote) => git(["ls-remote", remote, "HEAD"]).split(/\s/)[0].slice(0, 12);

const readMarker = (marker) => (existsSync(marker) ? readFileSync(marker, "utf8").trim() : null);

// Reference repos stay on the commit they were vendored at, so cited file:line stays valid.
// `--update` is the only way to move one forward.
const resolveRef = ({ remote, ref }, current, update) => {
  if (ref) return ref();
  if (current && !update) return current;
  return headSha(remote);
};

const cloneArgs = ({ remote, refIsBranch }, target, ref) => [
  "clone",
  "--depth",
  "1",
  ...(refIsBranch ? ["--branch", ref] : []),
  remote,
  target,
];

const vendor = (update) => (repo) => {
  const target = join(reposDir, repo.name);
  const marker = join(target, ".vendored");
  const current = readMarker(marker);
  const ref = resolveRef(repo, current, update);

  if (current === ref) {
    console.log(`.repos/${repo.name} already pinned to ${ref}`);
    return;
  }

  console.log(`Vendoring ${repo.name} at ${ref} into .repos/${repo.name} …`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(reposDir, { recursive: true });
  git(cloneArgs(repo, target, ref), { stdio: "inherit" });
  writeFileSync(marker, `${ref}\n`);
};

const args = process.argv.slice(2);
const update = args.includes("--update");
const only = args.filter((a) => a !== "--update");
const selected = only.length ? REPOS.filter((r) => only.includes(r.name)) : REPOS;

const unknown = only.filter((n) => !REPOS.some((r) => r.name === n));
if (unknown.length) {
  console.error(`Unknown repo(s): ${unknown.join(", ")}`);
  console.error(`Known: ${REPOS.map((r) => r.name).join(", ")}`);
  process.exit(1);
}

selected.forEach(vendor(update));
console.log("Done.");
