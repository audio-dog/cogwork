import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAssets } from "./lib/assets.js";
import { findPackageRoot, findRepoRoot } from "./lib/paths.js";
import { copyTree } from "./lib/skills.js";
import type { Mode, Target, TargetName } from "./lib/types.js";
import { type WriteResult, Writer } from "./lib/writer.js";
import { claude } from "./targets/claude.js";
import { codex } from "./targets/codex.js";
import { cursor } from "./targets/cursor.js";

const TARGETS: Record<TargetName, Target> = { claude, cursor, codex };
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(here);
const repoRoot = findRepoRoot(here);

interface Options {
  targets: TargetName[];
  mode: Mode;
  projectDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    targets: Object.keys(TARGETS) as TargetName[],
    mode: "global",
    projectDir: process.cwd(),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--target": {
        const value = argv[++i];
        if (!value) fail("--target requires a value (claude|cursor|codex|all)");
        opts.targets = value === "all" ? (Object.keys(TARGETS) as TargetName[]) : parseTargets(value);
        break;
      }
      case "--global":
        opts.mode = "global";
        break;
      case "--project": {
        opts.mode = "project";
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          opts.projectDir = resolve(next);
          i++;
        }
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function parseTargets(value: string): TargetName[] {
  return value.split(",").map((t) => {
    const name = t.trim();
    if (!(name in TARGETS)) fail(`unknown target: ${name}`);
    return name as TargetName;
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const assets = loadAssets(packageRoot, repoRoot);
  const writer = new Writer({ dryRun: opts.dryRun, repoRoot });
  const ctx = {
    mode: opts.mode,
    home: homedir(),
    projectDir: opts.projectDir,
    writer,
  };

  for (const name of opts.targets) TARGETS[name].write(assets, ctx);

  // Per-repo skill config is tool-agnostic — every tool's forked skills read the same
  // ~/.agents/repo-config home — so it syncs once, not per target.
  if (opts.mode === "global") {
    for (const cfg of assets.repoConfigs) {
      copyTree(writer, cfg.dir, cfg.files, join(ctx.home, ".agents", "repo-config", cfg.slug));
    }
  }

  report(writer.results, opts);
}

function report(results: WriteResult[], opts: Options) {
  const label = opts.dryRun ? "DRY RUN — no files written" : "Synced";
  console.log(`\n${label} (mode: ${opts.mode}, targets: ${opts.targets.join(", ")})\n`);
  const icon: Record<WriteResult["status"], string> = {
    create: "＋",
    update: "～",
    unchanged: "·",
    skip: "⤫",
  };
  for (const r of results) {
    const suffix = r.note ? `  (${r.note})` : "";
    console.log(`  ${icon[r.status]} ${r.status.padEnd(9)} ${rel(r.path)}${suffix}`);
  }
  const changed = results.filter((r) => r.status === "create" || r.status === "update").length;
  console.log(`\n${changed} file(s) ${opts.dryRun ? "would change" : "changed"}.\n`);
}

function rel(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? p.replace(home, "~") : p;
}

function printHelp() {
  console.log(`clanker-forge sync — render assets/ into each tool's native config

Usage:
  pnpm sync [--target claude|cursor|codex|all] [--global | --project [DIR]] [--dry-run]

Defaults: --target all, --global. Use --dry-run to preview changes.`);
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

main();
