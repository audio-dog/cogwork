#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

const windowPlan = [6, 8];
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

const preflight = async (profiling) => {
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
  // The V8 CPU profiler keeps its samples in the daemon heap and adds latency to the event loop —
  // the two signals a campaign exists to measure. Crash forensics (the fatal-error report and the
  // near-heap-limit snapshot) are unconditional in engine-command.ts and do not need this flag, so
  // a measurement run leaves it off and only a diagnostic run asks for it.
  writeFileSync(preferencesPath, JSON.stringify({ ...preferences, profiling }));

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
    profiling,
    preflightAt: stamp(),
    samplerPid: sampler.pid,
    processPressureCsv: csvPath,
    telemetryStore: telemetryPath,
    supersededTelemetry,
    supersededCsv,
    windows: [],
  });

  say(
    `profiling ${profiling ? "ON — the profiler perturbs loop delay and daemon heap" : "off"}, sampler running as pid ${sampler.pid}, manifest at ${manifestPath}`,
  );
  say("now do the two things only a human can do:");
  say(`  1. start the app:  cd ${repoRoot} && pnpm dev`);
  say("  2. open one item tab and leave it open");
  say("then run:  node scripts/perf-campaign.mjs run");
};

const holdWindow = async (manifest, agents, minutes) => {
  say(`${agents} agents: setting the limit`);
  setGlobalLimit(agents);
  const record = { agents, startedAt: stamp(), endedAt: null, daemonLostAt: null };
  manifest.windows.push(record);
  writeManifest(manifest);
  say(`${agents} agents: window open, holding ${minutes} minutes`);

  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    await wait(socketPollMillis);
    if (record.daemonLostAt) continue;
    if (await daemonListening()) continue;
    record.daemonLostAt = stamp();
    writeManifest(manifest);
    say(`${agents} agents: the daemon stopped answering at ${record.daemonLostAt}`);
  }
  record.endedAt = stamp();
  writeManifest(manifest);
  say(`${agents} agents: window closed`);
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
  for (const agents of windowPlan) {
    await holdWindow(manifest, agents, minutes);
  }
  setGlobalLimit(restingLimit);
  manifest.finishedAt = stamp();
  writeManifest(manifest);
  say("campaign complete — stop the app, then run: node scripts/perf-campaign.mjs readout");
};

// A live daemon keeps recent rows in the write-ahead log. `immutable=1` ignores that log, so it is
// only safe once the daemon has stopped and checkpointed — and it is the only thing that opens the
// store after that, when SQLite can no longer create the shared-memory file it wants.
class QueryFailed extends Error {}

// A store with a live writer needs its write-ahead log, which `mode=ro` reads and `immutable=1`
// ignores; a stopped daemon leaves no shared-memory file, which only `immutable=1` can open. Try
// the honest mode first, and let a genuine failure stop the readout rather than read as no rows.
const sqlite = (database, query) => {
  const attempts = [`file:${database}?mode=ro`, `file:${database}?mode=ro&immutable=1`];
  const failures = [];
  for (const uri of attempts) {
    const result = spawnSync("sqlite3", ["-json", uri, query], { encoding: "utf8" });
    if (result.status === 0) return { text: result.stdout.trim(), uri };
    failures.push(`${uri}: ${(result.stderr ?? "").trim()}`);
  }
  throw new QueryFailed(`every open mode failed for ${database}\n  ${failures.join("\n  ")}`);
};

const openModes = new Set();

const rows = (database, query) => {
  const { text, uri } = sqlite(database, query);
  openModes.add(uri.includes("immutable") ? "immutable" : "mode=ro");
  return text ? JSON.parse(text) : [];
};

const millis = (iso) => new Date(iso).getTime();

const percentile = (sorted, fraction) =>
  sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

const gaugeSeries = (store, metric, attribute, from, to) => {
  const filter = attribute ? `and json_extract(attributes,'$.process')='${attribute}'` : "";
  const values = rows(
    store,
    `select json_extract(state,'$.value') as value from metrics
     where name='${metric}' ${filter} and timestamp between ${from} and ${to} order by timestamp;`,
  ).map((row) => row.value);
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    first: values[0],
    last: values[values.length - 1],
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1],
  };
};

// Effect histograms accumulate from process start, so a single snapshot is a running total. The
// window's own work is the difference between its first and last snapshot; `max` stays a running
// maximum and cannot be differenced, so it is reported as such.
const histogramDelta = (store, metric, from, to) => {
  const snapshots = rows(
    store,
    `select json_extract(state,'$.count') as count, json_extract(state,'$.sum') as sum,
     json_extract(state,'$.max') as max from metrics where name='${metric}'
     and timestamp between ${from} and ${to} order by timestamp;`,
  );
  if (snapshots.length < 2) return undefined;
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const count = last.count - first.count;
  if (count <= 0) return undefined;
  return { count, mean: (last.sum - first.sum) / count, runningMax: last.max };
};

const bytes = (value) => (typeof value === "number" ? `${(value / (1024 * 1024)).toFixed(0)} MB` : "n/a");
const ms = (value) => (typeof value === "number" ? `${value.toFixed(value < 10 ? 2 : 1)} ms` : "n/a");

const durationMetrics = [
  ["run ledger append", "cogwork_run_ledger_append_duration"],
  ["control-store write gate wait", "cogwork_control_store_write_gate_wait_duration"],
  ["file-diff git diff exec", "cogwork_file_diff_git_diff_exec_duration"],
  ["worktree ensure", "cogwork_worktree_ensure_duration"],
  ["scheduler tick", "cogwork_scheduler_tick_duration"],
  ["harness event fold", "cogwork_harness_event_fold_duration"],
];

const reportConcurrency = (manifest, record, from, to) => {
  const inFlight = gaugeSeries(manifest.telemetryStore, "cogwork_scheduler_runs_in_flight", null, from, to);
  if (!inFlight) {
    console.log("  concurrency: not recorded — every rate below is unanchored");
    return record.agents;
  }
  const atLimit = rows(
    manifest.telemetryStore,
    `select count(*) as n from metrics where name='cogwork_scheduler_runs_in_flight'
     and timestamp between ${from} and ${to} and json_extract(state,'$.value')=${record.agents};`,
  )[0];
  const average =
    rows(
      manifest.telemetryStore,
      `select avg(json_extract(state,'$.value')) as mean from metrics
       where name='cogwork_scheduler_runs_in_flight' and timestamp between ${from} and ${to};`,
    )[0]?.mean ?? record.agents;
  console.log(
    `  concurrency: limit ${record.agents}, realized mean ${average.toFixed(2)}, peak ${inFlight.max}, at the limit for ${atLimit?.n ?? 0} of ${inFlight.samples} samples`,
  );
  return average;
};

const reportPressure = (manifest, from, to) => {
  if (!existsSync(manifest.processPressureCsv)) {
    console.log("  descriptors: no CSV at the recorded path");
    return;
  }
  const lines = readFileSync(manifest.processPressureCsv, "utf8").split("\n").slice(1);
  const inWindow = lines.flatMap((line) => {
    const [, epoch, role, , , descriptors, , rss] = line.split(",");
    const at = Number(epoch);
    if (!at || at < from || at > to) return [];
    return [{ at, role, descriptors: Number(descriptors), rss: Number(rss) }];
  });
  const ticks = new Set(inWindow.map((entry) => entry.at)).size;
  if (ticks === 0) {
    console.log("  descriptors: the sampler recorded nothing in this window");
    return;
  }
  const expected = Math.floor((to - from) / 5000);
  if (ticks < expected * 0.9) {
    console.log(`  WARNING: ${ticks} sampler ticks for a window that should hold about ${expected}`);
  }
  const sum = (predicate, field) =>
    inWindow.reduce((total, entry) => (predicate(entry) ? total + entry[field] : total), 0);
  const harnessCount = inWindow.filter((entry) => entry.role === "harness").length;
  console.log(
    `  descriptors: ~${Math.round(sum(() => true, "descriptors") / ticks)} per tick across all roles · ~${(harnessCount / ticks).toFixed(1)} agent processes · limit ${manifest.fileDescriptorLimit} (read from the preflight shell, not from the app)`,
  );
  // Summing resident memory across processes counts every shared page once per process, so the
  // total is fiction. The heaviest single process is a number that means something.
  const heaviest = inWindow.reduce((worst, entry) => (entry.rss > worst.rss ? entry : worst), inWindow[0]);
  console.log(`  heaviest single process: ${bytes(heaviest.rss * 1024)} resident (${heaviest.role})`);
};

const reportWindow = (manifest, record) => {
  const from = millis(record.startedAt);
  const to = record.endedAt ? millis(record.endedAt) : Date.now();
  console.log(
    `\n=== window labelled ${record.agents} agents · ${record.startedAt} → ${record.endedAt ?? "open"} ===`,
  );
  if (record.daemonLostAt) console.log(`  the daemon stopped answering at ${record.daemonLostAt}`);

  const realized = reportConcurrency(manifest, record, from, to);

  for (const subject of ["daemon", "renderer", "main"]) {
    const heap = gaugeSeries(manifest.telemetryStore, "cogwork_process_heap_used_bytes", subject, from, to);
    const limit = gaugeSeries(manifest.telemetryStore, "cogwork_process_heap_limit_bytes", subject, from, to);
    if (!heap) continue;
    const share = limit?.max ? ` (peak ${((heap.max / limit.max) * 100).toFixed(1)}% of limit)` : "";
    console.log(
      `  ${subject} heap: ${bytes(heap.first)} → ${bytes(heap.last)}, peak ${bytes(heap.max)}${share}`,
    );
  }

  for (const subject of ["daemon", "main"]) {
    const delay = gaugeSeries(
      manifest.telemetryStore,
      "cogwork_process_event_loop_delay_p99_milliseconds",
      subject,
      from,
      to,
    );
    if (!delay) continue;
    console.log(
      `  ${subject} loop delay p99: median ${ms(delay.median)}, p90 ${ms(delay.p90)}, peak ${ms(delay.max)} over ${delay.samples} samples`,
    );
  }

  for (const [label, metric] of durationMetrics) {
    const summary = histogramDelta(manifest.telemetryStore, metric, from, to);
    if (!summary) continue;
    console.log(
      `  ${label}: ${summary.count} in window, mean ${ms(summary.mean)}, running max ${ms(summary.runningMax)}`,
    );
  }

  const dropped = histogramDelta(
    manifest.telemetryStore,
    "cogwork_daemon_event_bus_dropped_events_total",
    from,
    to,
  );
  console.log(
    dropped
      ? `  event bus dropped ${dropped.count} events`
      : "  event bus drops: the counter never reached the store — unrecorded, not zero",
  );

  reportPressure(manifest, from, to);

  const events = rows(
    join(daemonHome, "control.db"),
    `select count(*) as total, sum(case when name='sandbox.file.diff' then 1 else 0 end) as diffs,
     count(distinct run_id) as runs from run_events where at between ${from} and ${to};`,
  )[0];
  if (events?.total) {
    const seconds = (to - from) / 1000;
    const share = ((events.diffs / events.total) * 100).toFixed(1);
    console.log(
      `  ${events.total} events across ${events.runs} runs = ${(events.total / seconds).toFixed(1)}/second total, ${(events.total / seconds / realized).toFixed(2)} per realized agent · sandbox.file.diff ${share}%`,
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
  if (manifest.profiling) {
    console.log("WARNING: the daemon ran under --cpu-prof --heap-prof, which inflates loop delay and heap");
  }
  try {
    for (const record of manifest.windows) reportWindow(manifest, record);
  } catch (error) {
    if (!(error instanceof QueryFailed)) throw error;
    say(`readout stopped: ${describe(error)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nread through: ${[...openModes].join(", ")}`);

  reportProcessExits(manifest);
};

const exitPhrases = [
  "Engine closed",
  "Engine closed unexpectedly",
  "Engine closed after SIGKILL",
  "Engine restart budget exhausted",
  "Child process gone",
  "Render process gone",
];

// electron-log writes a timestamped header line and then the structured body, so the phrase that
// names a death sits on a later line with no timestamp of its own. Carry the last header forward.
// The log rotates at 1 MB, and a campaign is long enough to cross that, so read the previous file
// too rather than silently losing half the window.
const reportProcessExits = (manifest) => {
  const first = millis(manifest.windows[0].startedAt);
  const last = millis(manifest.windows[manifest.windows.length - 1].endedAt ?? stamp());
  console.log("\n=== process exits during the campaign ===");
  const files = [`${desktopLogPath.replace(/\.log$/, ".old.log")}`, desktopLogPath].filter((file) =>
    existsSync(file),
  );
  if (files.length === 0) {
    say(`no desktop log at ${desktopLogPath} — this section proves nothing`);
    return;
  }
  const found = [];
  for (const file of files) {
    let header = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const at = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line);
      if (at) header = new Date(at[1].replace(" ", "T")).getTime();
      if (header === null || header < first || header > last) continue;
      if (exitPhrases.some((phrase) => line.includes(phrase))) found.push(`${line.trim()}`);
    }
  }
  console.log(
    found.length
      ? found.join("\n")
      : `no process exited between ${manifest.windows[0].startedAt} and the last window`,
  );
  console.log(`(scanned ${files.length} log file${files.length === 1 ? "" : "s"})`);
};

const command = process.argv[2];
const flags = process.argv.slice(3).filter((argument) => argument.startsWith("--"));
const positional = process.argv.slice(3).filter((argument) => !argument.startsWith("--"));

const minutesFrom = (argument) => {
  if (argument === undefined) return 20;
  const parsed = Number.parseInt(argument, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

if (command === "preflight") await preflight(flags.includes("--profile"));
else if (command === "run") {
  const minutes = minutesFrom(positional[0]);
  // A NaN deadline compares false, so an unvalidated argument would close both windows at once and
  // report a complete campaign over two empty windows.
  if (minutes === null) {
    say(`not a positive number of minutes: ${positional[0]}`);
    process.exitCode = 1;
  } else await run(minutes);
} else if (command === "readout") readout();
else {
  say("usage: perf-campaign.mjs preflight [--profile] | run [minutes] | readout");
  process.exitCode = 1;
}
