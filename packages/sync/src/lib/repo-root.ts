import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function findRepoRoot(startDir: string): string {
  if (existsSync(join(startDir, "pnpm-workspace.yaml"))) return startDir;
  const parent = dirname(startDir);
  if (parent === startDir) {
    throw new Error("could not locate repo root: no pnpm-workspace.yaml in any ancestor");
  }
  return findRepoRoot(parent);
}
