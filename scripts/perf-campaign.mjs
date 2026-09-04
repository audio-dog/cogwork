#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const daemonHome = join(homedir(), ".cogwork");
const socketPath = join(daemonHome, "cogwork.sock");
const telemetryPath = join(daemonHome, "telemetry.db");
const campaignDirectory = join(homedir(), "campaign");
const manifestPath = join(campaignDirectory, "manifest.json");
const csvPath = join(campaignDirectory, "process-pressure.csv");
const preferencesPath = join(
  homedir(),
  "Library",
  "Application Support",
  "@cogwork",
  "desktop",
  "window-preferences.json",
);
const desktopLogPath = join(homedir(), "Library", "Logs", "@cogwork", "desktop", "main.log");

const windowPlan = [{ agents: 6 }, { agents: 8 }];
const restingLimit = 3;
const socketPollMillis = 5_000;

const describe = (error) => (error instanceof Error ? error.message : String(error));
const say = (message) => console.log(`perf-campaign: ${message}`);
const stamp = () => new Date().toISOString();
const wait = (millis) => new Promise((resolve) => setTimeout(resolve, millis));

const capture = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (error) {
    return typeof error?.stdout === "string" ? error.stdout.trim() : "";
  }
};

const daemonListening = () =>
  new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const settle = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    const timer = setTimeout(() => settle(false), 500);
    socket.once("connect", () => {
      clearTimeout(timer);
      settle(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      settle(false);
    });
  });

const readManifest = () => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
};

const writeManifest = (manifest) => {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

const rollAside = (path) => {
  if (!existsSync(path)) return null;
  const moved = join(campaignDirectory, `superseded-${Date.now()}-${path.split("/").pop()}`);
  renameSync(path, moved);
  return moved;
};

// `limits set` goes over the daemon socket, so the daemon must already be listening. Calling the CLI
// entry directly skips the several seconds `pnpm --filter` costs on every invocation.
const setGlobalLimit = (value) => {
  const tsx = join(repoRoot, "apps", "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const entry = join(repoRoot, "apps", "cli", "src", "main.ts");
  return capture(process.execPath, [tsx, entry, "limits", "set", "global-concurrency", String(value)]);
};

const preflight = async () => {
  if (await daemonListening()) {
    say("a daemon is listening — stop the app first, then run preflight again");
    process.exitCode = 1;
    return;
  }
  mkdirSync(campaignDirectory, { recursive: true });
  const supersededTelemetry = rollAside(telemetryPath);
  for (const suffix of ["-wal", "-shm"]) rollAside(`${telemetryPath}${suffix}`);
  const supersededCsv = rollAside(csvPath);

  mkdirSync(dirname(preferencesPath), { recursive: true });
  const preferences = existsSync(preferencesPath)
    ? JSON.parse(readFileSync(preferencesPath, "utf8"))
    : { closeToHide: true };
  writeFileSync(preferencesPath, JSON.stringify({ ...preferences, profiling: true }));

  const sampler = spawn(
    process.execPath,
    [join(repoRoot, "scripts", "process-pressure-sampler.mjs"), csvPath],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  sampler.unref();

  writeManifest({
    repoRoot,
    commit: capture("git", ["-C", repoRoot, "rev-parse", "HEAD"]),
    fileDescriptorLimit: capture("sh", ["-c", "ulimit -n"]),
    preflightAt: stamp(),
    samplerPid: sampler.pid,
    processPressureCsv: csvPath,
    telemetryStore: telemetryPath,
    supersededTelemetry,
    supersededCsv,
    windows: [],
  });

  say(`profiling enabled, sampler running as pid ${sampler.pid}, manifest at ${manifestPath}`);
  say("now do the two things only a human can do:");
  say(`  1. start the app:  cd ${repoRoot} && pnpm dev`);
  say("  2. open one item tab and leave it open");
  say("then run:  node scripts/perf-campaign.mjs run");
};

const holdWindow = async (manifest, index, minutes) => {
  const plan = windowPlan[index];
  say(`${plan.agents} agents: setting the limit`);
  setGlobalLimit(plan.agents);
  const record = { agents: plan.agents, startedAt: stamp(), endedAt: null, daemonLostAt: null };
  manifest.windows.push(record);
  writeManifest(manifest);
  say(`${plan.agents} agents: window open, holding ${minutes} minutes`);

  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    await wait(socketPollMillis);
    if (record.daemonLostAt) continue;
    if (await daemonListening()) continue;
    record.daemonLostAt = stamp();
    writeManifest(manifest);
    say(`${plan.agents} agents: the daemon stopped answering at ${record.daemonLostAt}`);
  }
  record.endedAt = stamp();
  writeManifest(manifest);
  say(`${plan.agents} agents: window closed`);
};

const run = async (minutes) => {
  const manifest = readManifest();
  if (!manifest) {
    say("no manifest — run preflight first");
    process.exitCode = 1;
    return;
  }
  say("waiting for the daemon (start the app now if you have not)");
  while (!(await daemonListening())) await wait(socketPollMillis);
  say("daemon is up");

  manifest.windows = [];
  for (let index = 0; index < windowPlan.length; index += 1) {
    await holdWindow(manifest, index, minutes);
  }
  setGlobalLimit(restingLimit);
  manifest.finishedAt = stamp();
  writeManifest(manifest);
  say("campaign complete — stop the app, then run: node scripts/perf-campaign.mjs readout");
};

// A live daemon keeps recent rows in the write-ahead log. `immutable=1` ignores that log, so it is
// only safe once the daemon has stopped and checkpointed — and it is the only thing that opens the
// store after that, when SQLite can no longer create the shared-memory file it wants.
const sqlite = (database, query) => {
  const plain = capture("sqlite3", ["-json", `file:${database}?mode=ro`, query]);
  if (plain !== "") return plain;
  return capture("sqlite3", ["-json", `file:${database}?mode=ro&immutable=1`, query]);
};

const rows = (database, query) => {
  const output = sqlite(database, query);
  try {
    return output ? JSON.parse(output) : [];
  } catch (error) {
    say(`query failed: ${describe(error)}`);
    return [];
  }
};

const millis = (iso) => new Date(iso).getTime();

const gaugeSummary = (store, metric, process, from, to) =>
  rows(
    store,
    `select min(json_extract(state,'$.value')) as low, max(json_extract(state,'$.value')) as high,
     count(*) as samples from metrics where name='${metric}'
     and json_extract(attributes,'$.process')='${process}'
     and timestamp between ${from} and ${to};`,
  )[0];

const bytes = (value) => (typeof value === "number" ? `${(value / (1024 * 1024)).toFixed(0)} MB` : "n/a");

const reportWindow = (manifest, record) => {
  const from = millis(record.startedAt);
  const to = record.endedAt ? millis(record.endedAt) : Date.now();
  console.log(`\n=== ${record.agents} agents · ${record.startedAt} → ${record.endedAt ?? "open"} ===`);
  if (record.daemonLostAt) console.log(`(a) the daemon stopped answering at ${record.daemonLostAt}`);

  for (const process of ["renderer", "daemon", "main"]) {
    const heap = gaugeSummary(manifest.telemetryStore, "cogwork_process_heap_used_bytes", process, from, to);
    if (heap?.samples) {
      console.log(
        `(b) ${process} heap: ${bytes(heap.low)} → ${bytes(heap.high)} over ${heap.samples} samples`,
      );
    }
  }

  const delay = gaugeSummary(
    manifest.telemetryStore,
    "cogwork_process_event_loop_delay_p99_milliseconds",
    "daemon",
    from,
    to,
  );
  if (delay?.samples) {
    console.log(`(c) daemon loop delay p99: ${delay.low?.toFixed(1)} – ${delay.high?.toFixed(1)} ms`);
  }
  const append = rows(
    manifest.telemetryStore,
    `select json_extract(state,'$.count') as count, json_extract(state,'$.max') as max,
     json_extract(state,'$.sum') as sum from metrics where name='cogwork_run_ledger_append_duration'
     and timestamp between ${from} and ${to} order by timestamp desc limit 1;`,
  )[0];
  if (append?.count) {
    console.log(
      `(c) ledger appends: ${append.count} total, max ${append.max?.toFixed(2)} ms, mean ${(append.sum / append.count).toFixed(2)} ms`,
    );
  }

  const pressure = readFileSync(manifest.processPressureCsv, "utf8").split("\n").slice(1);
  const inWindow = pressure.flatMap((line) => {
    const [, epoch, role, , , descriptors] = line.split(",");
    const at = Number(epoch);
    if (!at || at < from || at > to) return [];
    return [{ role, descriptors: Number(descriptors) }];
  });
  const totalsByTick = inWindow.reduce((sum, entry) => sum + entry.descriptors, 0);
  const harnessCount = inWindow.filter((entry) => entry.role === "harness").length;
  const ticks = new Set(
    pressure.flatMap((line) => {
      const at = Number(line.split(",")[1]);
      return at >= from && at <= to ? [at] : [];
    }),
  ).size;
  if (ticks > 0) {
    console.log(
      `(d) descriptors: ~${Math.round(totalsByTick / ticks)} per tick across all roles · ~${Math.round(harnessCount / ticks)} harness processes · limit ${manifest.fileDescriptorLimit}`,
    );
  }

  const dropped = rows(
    manifest.telemetryStore,
    `select coalesce(json_extract(state,'$.count'), 0) as drops from metrics
     where name='cogwork_daemon_event_bus_dropped_events_total'
     and timestamp between ${from} and ${to} order by timestamp desc limit 1;`,
  )[0];
  console.log(
    dropped
      ? `(f) daemon event bus dropped ${dropped.drops} events`
      : "(f) daemon event bus drops: the counter never reached the store — treat as unrecorded, not as zero",
  );

  const control = join(daemonHome, "control.db");
  const events = rows(
    control,
    `select count(*) as total, sum(case when name='sandbox.file.diff' then 1 else 0 end) as diffs,
     count(distinct run_id) as runs from run_events where at between ${from} and ${to};`,
  )[0];
  if (events?.total) {
    const seconds = (to - from) / 1000;
    const share = ((events.diffs / events.total) * 100).toFixed(1);
    const perAgent = events.total / seconds / record.agents;
    console.log(
      `(e) ${events.total} events across ${events.runs} runs = ${(events.total / seconds).toFixed(1)} events/second total, ${perAgent.toFixed(2)} per agent · sandbox.file.diff ${share}%`,
    );
  }
};

const readout = () => {
  const manifest = readManifest();
  if (!manifest?.windows?.length) {
    say("no windows recorded — run preflight and run first");
    process.exitCode = 1;
    return;
  }
  console.log(`commit ${manifest.commit}`);
  console.log(`descriptor limit ${manifest.fileDescriptorLimit}`);
  for (const record of manifest.windows) reportWindow(manifest, record);

  const first = millis(manifest.windows[0].startedAt);
  const last = millis(manifest.windows[manifest.windows.length - 1].endedAt ?? stamp());
  console.log("\n=== (a) process exits during the campaign ===");
  const scanned = capture("grep", ["-aE", "Engine closed|process-gone|restart budget", desktopLogPath]);
  // electron-log writes local time as `[YYYY-MM-DD HH:MM:SS.mmm]`; lines outside the campaign are
  // history from earlier sessions and would read as this campaign's crashes.
  const inCampaign = scanned.split("\n").filter((line) => {
    const at = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
    if (!at) return false;
    const when = new Date(at[1].replace(" ", "T")).getTime();
    return when >= first && when <= last;
  });
  console.log(inCampaign.length ? inCampaign.join("\n") : "no process exited during either window");
};

const command = process.argv[2];
const minutesArgument = Number.parseInt(process.argv[3] ?? "20", 10);

if (command === "preflight") await preflight();
else if (command === "run") await run(minutesArgument);
else if (command === "readout") readout();
else {
  say("usage: perf-campaign.mjs preflight | run [minutes] | readout");
  process.exitCode = 1;
}
