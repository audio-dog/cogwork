#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const worktreeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(worktreeRoot, "scripts", "worktree-manifest.json");

const describe = (error) => (error instanceof Error ? error.message : String(error));
const warn = (message) => console.warn(`setup-worktree: ${message}`);

const resolveSharedCheckout = () => {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: worktreeRoot,
    encoding: "utf8",
  }).trim();
  return dirname(resolve(worktreeRoot, commonDir));
};

const resolveMainCheckout = () => {
  const fromEnv = process.env.ROOT_WORKTREE_PATH?.trim();
  return fromEnv ? resolve(fromEnv) : resolveSharedCheckout();
};

const readManifest = () => {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("manifest must be a JSON array of paths");
  return [...new Set(parsed)];
};

const vendorRepos = (mainCheckout) => {
  warn(`.repos missing in ${mainCheckout}; running \`pnpm vendor\` to restore it`);
  execFileSync("pnpm", ["vendor"], { cwd: mainCheckout, stdio: "inherit" });
};

const trustCodexHooks = (sharedCheckout) =>
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@cogwork/cli",
      "exec",
      "tsx",
      "src/trust-codex-hooks.ts",
      sharedCheckout,
      process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    ],
    { cwd: sharedCheckout, stdio: "inherit", timeout: 30_000 },
  );

const targetIn = (mainCheckout, relative) => {
  const target = join(mainCheckout, relative);
  if (existsSync(target)) return target;
  if (relative !== ".repos") return null;
  vendorRepos(mainCheckout);
  return existsSync(target) ? target : null;
};

const alreadyLinked = (linkLocation, target) =>
  resolve(dirname(linkLocation), readlinkSync(linkLocation)) === target;

const hydrate = (mainCheckout, relative) => {
  const target = targetIn(mainCheckout, relative);
  if (!target) {
    warn(`skipping ${relative}: not present in ${mainCheckout}`);
    return;
  }
  const linkLocation = join(worktreeRoot, relative);
  const existing = lstatSync(linkLocation, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) {
    warn(`skipping ${relative}: ${linkLocation} exists and is not a symlink`);
    return;
  }
  if (existing && alreadyLinked(linkLocation, target)) return;
  rmSync(linkLocation, { force: true });
  mkdirSync(dirname(linkLocation), { recursive: true });
  symlinkSync(target, linkLocation);
  console.log(`setup-worktree: linked ${relative} -> ${target}`);
};

const hydrateWorktree = (mainCheckout) => {
  if (mainCheckout === worktreeRoot) {
    console.log("setup-worktree: running in the main checkout; nothing to hydrate");
    return;
  }
  for (const relative of readManifest()) {
    try {
      hydrate(mainCheckout, relative);
    } catch (error) {
      warn(`skipping ${relative}: ${describe(error)}`);
    }
  }
};

const main = () => {
  hydrateWorktree(resolveMainCheckout());
  trustCodexHooks(resolveSharedCheckout());
};

try {
  main();
} catch (error) {
  warn(describe(error));
}
