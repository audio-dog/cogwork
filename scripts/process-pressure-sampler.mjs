#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const describe = (error) => (error instanceof Error ? error.message : String(error));
const warn = (message) => console.warn(`process-pressure-sampler: ${message}`);

const output = resolve(process.argv[2] ?? "process-pressure.csv");
const intervalMillis = Number.parseInt(process.argv[3] ?? "5000", 10);
const columns = [
  "sampledAt",
  "epochMillis",
  "role",
  "pid",
  "commandName",
  "fileDescriptors",
  "directChildren",
  "rssKilobytes",
];

// `ps` and `lsof` exit non-zero when a sampled process dies mid-call, and their partial output is
// still the truth for every process that survived, so a failed exit keeps whatever reached stdout.
const capture = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
};

const commandName = (command) => command.trim().split(/\s+/)[0]?.split("/").pop() ?? "";

const processTable = () => {
  const lines = capture("ps", ["-Ao", "pid=,ppid=,rss=,command="]).split("\n");
  const parsed = lines.flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) return [];
    const pid = Number(match[1]);
    return [[pid, { pid, parent: Number(match[2]), rssKilobytes: Number(match[3]), command: match[4] }]];
  });
  return new Map(parsed);
};

const childIndex = (table) => {
  const children = new Map();
  for (const row of table.values()) {
    children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  }
  return children;
};

const descendants = (children, pid) => {
  const found = [];
  const pending = [...(children.get(pid) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    found.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  return found;
};

// The desktop shell spawns the engine as a plain Node child, so the daemon's own command line is the
// only stable anchor: it names the socket flag in both the dev entry and the packaged entry.
const isEngine = (command) =>
  command.includes("daemon") &&
  command.includes("--socket") &&
  (command.includes("apps/cli/src/main.ts") || command.includes("engine/index.js"));

const helperRoles = new Map([
  ["renderer", "renderer"],
  ["gpu-process", "gpu"],
  ["utility", "utility"],
]);

const helperRole = (command) => {
  if (command.includes("crashpad")) return null;
  const type = /--type=([a-z-]+)/.exec(command)?.[1];
  return type === undefined ? null : (helperRoles.get(type) ?? null);
};

const harnessCommands = new Set(["codex", "cursor-agent", "claude"]);

// The engine's subtree holds far more than agents: package managers, build tools, shells and the
// harness CLI's own helpers. Counting all of it as "harness" overstated the agent count sevenfold
// in the first campaign, so only the agent CLI itself carries that name.
const engineChildRole = (command) => {
  const name = commandName(command);
  if (name === "git") return "git";
  return harnessCommands.has(name) ? "harness" : "engine-child";
};

const targets = (table, children) => {
  const engine = [...table.values()].find((row) => isEngine(row.command));
  if (!engine) return [];
  const engineSubtree = descendants(children, engine.pid).flatMap((pid) => {
    const row = table.get(pid);
    return row ? [{ role: engineChildRole(row.command), row }] : [];
  });
  const parent = table.get(engine.parent);
  // A daemon started by hand has a shell as its parent, and labelling that shell "main" would put
  // numbers that are not the app's under the app's roles.
  const main = parent?.command.includes("Electron") ? parent : undefined;
  if (!main) return [{ role: "engine", row: engine }, ...engineSubtree];
  const helpers = descendants(children, main.pid).flatMap((pid) => {
    const row = table.get(pid);
    const role = row ? helperRole(row.command) : null;
    return role ? [{ role, row }] : [];
  });
  return [{ role: "main", row: main }, { role: "engine", row: engine }, ...helpers, ...engineSubtree];
};

const fileDescriptorCounts = (pids) => {
  const counts = new Map(pids.map((pid) => [pid, 0]));
  if (pids.length === 0) return counts;
  // lsof lists cwd, txt, rtd and every mapped region beside the numbered descriptors. Counting
  // those inflated the first campaign's figures by about half, so match only a numeric FD column.
  for (const line of capture("lsof", ["-nP", "-p", pids.join(",")]).split("\n")) {
    const match = /^\S+\s+(\d+)\s+\S+\s+(\d+)[rwu-]/.exec(line);
    const pid = match ? Number(match[1]) : undefined;
    if (pid === undefined || !counts.has(pid)) continue;
    counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  return counts;
};

let missingEngineReported = false;

const sample = () => {
  const table = processTable();
  const children = childIndex(table);
  const sampled = targets(table, children);
  if (sampled.length === 0) {
    if (!missingEngineReported) warn("no engine daemon found yet — waiting");
    missingEngineReported = true;
    return;
  }
  missingEngineReported = false;
  const descriptors = fileDescriptorCounts(sampled.map(({ row }) => row.pid));
  const epochMillis = Date.now();
  const sampledAt = new Date(epochMillis).toISOString();
  const rows = sampled.map(({ role, row }) =>
    [
      sampledAt,
      epochMillis,
      role,
      row.pid,
      commandName(row.command),
      descriptors.get(row.pid) ?? 0,
      (children.get(row.pid) ?? []).length,
      row.rssKilobytes,
    ].join(","),
  );
  appendFileSync(output, `${rows.join("\n")}\n`);
};

const start = () => {
  if (!existsSync(output)) writeFileSync(output, `${columns.join(",")}\n`);
  const limit = capture("sh", ["-c", "ulimit -n"]).trim();
  warn(`writing ${output} every ${intervalMillis} ms — file-descriptor soft limit is ${limit}`);
  const timer = setInterval(() => {
    try {
      sample();
    } catch (error) {
      warn(`sample failed: ${describe(error)}`);
    }
  }, intervalMillis);
  process.once("SIGINT", () => {
    clearInterval(timer);
    warn(`stopped — ${output}`);
    process.exit(0);
  });
  sample();
};

start();
