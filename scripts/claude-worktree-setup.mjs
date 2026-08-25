#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Claude Code keeps CLAUDE_PROJECT_DIR at the directory the session started in, even after the
// session moves into a worktree; only the hook payload's `cwd` follows. Resolve the root from
// stdin or this hook hydrates the main checkout and silently skips every worktree.
const readStdin = async () => {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const rootFrom = (raw) => {
  try {
    return resolve(JSON.parse(raw).cwd ?? process.cwd());
  } catch {
    return resolve(process.cwd());
  }
};

const mainCheckoutOf = (root) => {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(resolve(root, commonDir));
  } catch {
    return root;
  }
};

const report = (message) => console.log(`claude-worktree-setup: ${message}`);

const hydrateLinks = (root) => {
  const script = join(root, "scripts", "setup-worktree.mjs");
  if (!existsSync(script)) return;
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  `${result.stdout ?? ""}${result.stderr ?? ""}`
    .split("\n")
    .filter((line) => line.includes("linked ") || line.includes("skipping "))
    .forEach((line) => {
      console.log(line);
    });
};

const installDependencies = (root) => {
  if (existsSync(join(root, "node_modules"))) return;
  report("installing dependencies (pnpm install)");
  const result = spawnSync("pnpm", ["install"], { cwd: root, encoding: "utf8" });
  if (result.status === 0) return report("dependencies installed");
  report(`pnpm install failed; run it yourself in ${root}`);
  if (result.stderr) console.log(result.stderr.trimEnd().split("\n").slice(-5).join("\n"));
};

const root = rootFrom(await readStdin());
if (root === mainCheckoutOf(root)) process.exit(0);

hydrateLinks(root);
installDependencies(root);
