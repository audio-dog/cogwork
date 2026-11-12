#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const checkoutRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const warn = (message) => console.warn(`install-commit-hook: ${message}`);

const gitPath = (flag) =>
  execFileSync("git", ["rev-parse", flag], { cwd: checkoutRoot, encoding: "utf8" }).trim();

// The shim prek writes holds the absolute path of the `prek` binary in the checkout that wrote it,
// and Git shares one hook directory with every linked worktree. A worktree that wrote the shim
// would leave a dead path behind when it is removed, and every remaining checkout would then fail
// to commit. Only the main checkout, whose node_modules outlives any worktree, may write it.
const isLinkedWorktree = () => gitPath("--git-dir") !== gitPath("--git-common-dir");

const main = () => {
  if (isLinkedWorktree()) {
    console.log("install-commit-hook: linked worktree; the main checkout owns the shared shim");
    return;
  }
  execFileSync("pnpm", ["exec", "prek", "install", "--allow-missing-config"], {
    cwd: checkoutRoot,
    stdio: "inherit",
  });
};

try {
  main();
} catch (error) {
  warn(error instanceof Error ? error.message : String(error));
}
