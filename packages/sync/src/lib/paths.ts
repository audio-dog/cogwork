import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function findUp(startDir: string, marker: string): string {
  if (existsSync(join(startDir, marker))) return startDir;
  const parent = dirname(startDir);
  if (parent === startDir) {
    throw new Error(`could not locate ${marker} in any ancestor of ${startDir}`);
  }
  return findUp(parent, marker);
}

export function findRepoRoot(startDir: string) {
  return findUp(startDir, "pnpm-workspace.yaml");
}

export function findPackageRoot(startDir: string) {
  return findUp(startDir, "package.json");
}
