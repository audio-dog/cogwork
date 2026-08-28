#!/usr/bin/env node
// Dev-only re-seed for the Control store. Pre-alpha has no migrations, so a schema move means
// deleting ~/.cogwork/control.db — which drops every registered workspace. This replays the
// registration act from inputs kept outside any repository, in ~/.cogwork/registrations/.
// Retire this once workspaces are registered from the Workspaces surface (#234).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cogworkHome = process.env.COGWORK_HOME?.trim() || join(homedir(), ".cogwork");
const registrationsDir = join(cogworkHome, "registrations");
const socketPath = process.env.COGWORK_SOCKET?.trim() || join(cogworkHome, "cogwork.sock");
const cli = join(repoRoot, "apps", "cli", "src", "main.ts");

const fail = (message) => {
  console.error(`register-workspaces: ${message}`);
  process.exit(1);
};

const inputsFor = (requested) => {
  if (!existsSync(registrationsDir)) {
    mkdirSync(registrationsDir, { recursive: true });
    fail(`no registration inputs found. Add one at ${join(registrationsDir, "<name>.json")}`);
  }
  const all = readdirSync(registrationsDir).filter((entry) => entry.endsWith(".json"));
  if (all.length === 0) fail(`no registration inputs in ${registrationsDir}`);
  if (requested.length === 0) return all;
  return requested.map((name) => {
    const file = name.endsWith(".json") ? name : `${name}.json`;
    if (!all.includes(file)) fail(`no registration input named ${file} in ${registrationsDir}`);
    return file;
  });
};

if (!existsSync(socketPath)) fail(`no daemon socket at ${socketPath}. Start the daemon first.`);

// Re-running after a wipe is the point, so an input that is already registered is not an error:
// the daemon rejects a duplicate checkout path, and that means the seed already holds.
const alreadyRegistered = (output) => /already registered/.test(output);

let failed = 0;
for (const file of inputsFor(process.argv.slice(2))) {
  const args = [
    "exec",
    "tsx",
    cli,
    "workspace",
    "register",
    "--socket",
    socketPath,
    "--input",
    join(registrationsDir, file),
  ];
  try {
    const stdout = execFileSync("pnpm", args, {
      cwd: join(repoRoot, "apps", "cli"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(stdout);
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (alreadyRegistered(output)) {
      console.log(`${file}: already registered, left alone`);
      continue;
    }
    console.error(`${file}: registration failed`);
    process.stderr.write(output);
    failed += 1;
  }
}
process.exit(failed === 0 ? 0 : 1);
