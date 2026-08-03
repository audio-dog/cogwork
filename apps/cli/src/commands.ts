import { DaemonRpcs, type RunEvent, RunId, type RunSummary } from "@clanker-forge/contracts";
import { Daemon, Registry } from "@clanker-forge/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { defaultConfigHome, defaultLedgerPath, defaultSocketPath } from "./paths";
import { clientLayer, type DaemonOptions, serverLayer } from "./rpc";
import { formatStatus } from "./status";
import { flushWatch, initialWatchState, stepWatch } from "./watch";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const configHomeFlag = Flag.string("config-home").pipe(
  Flag.withDescription("Directory of workspace config files the daemon imports"),
  Flag.withDefault(defaultConfigHome),
);

const ledgerFlag = Flag.string("ledger").pipe(
  Flag.withDescription("Path to the run ledger (disposable SQLite cache)"),
  Flag.withDefault(defaultLedgerPath),
);

const maxConcurrencyFlag = Flag.integer("max-concurrency").pipe(
  Flag.withDescription("Maximum concurrent agent sessions across all workspaces"),
  Flag.withDefault(4),
);

const dailyBudgetFlag = Flag.integer("daily-budget").pipe(
  Flag.withDescription("Maximum agent sessions started per UTC day across all workspaces"),
  Flag.withDefault(50),
);

const pollIntervalFlag = Flag.integer("poll-interval").pipe(
  Flag.withDescription("Seconds between work-source polls (higher values conserve GitHub API quota)"),
  Flag.withDefault(60),
);

const runIdFlag = Flag.string("id").pipe(Flag.withDescription("Run id to inspect"));

const watchIdFlag = Flag.string("id").pipe(
  Flag.withDescription("Only follow a single run id"),
  Flag.optional,
);

const runDaemon = Effect.fn("commands.runDaemon")(
  function* (options: DaemonOptions) {
    const registry = yield* Registry.WorkspaceRegistry;
    yield* Effect.logInfo("clanker-forge daemon started", {
      socket: options.socketPath,
      configHome: options.configHome,
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
    });
    yield* Effect.forEach(
      registry.failures,
      (failure) =>
        Effect.logWarning("workspace registration failed", {
          source: failure.source,
          message: failure.message,
        }),
      { discard: true },
    );
    yield* Daemon.bootstrap;
    yield* Effect.all([Daemon.reconcileHeartbeat(options.pollIntervalMillis), Daemon.executeHeartbeat], {
      concurrency: "unbounded",
    });
  },
  (effect, options) => effect.pipe(Effect.provide(serverLayer(options))),
);

const formatRun = (run: RunSummary) => {
  const session = run.session ? `  session=${run.session}` : "";
  const usage = run.usage?.totalTokens === undefined ? "" : `  tokens=${run.usage.totalTokens}`;
  return `  ${run.id}  ${run.status}  ${run.stage}  ${run.workItem} [${run.harness}]  events=${run.eventCount}${session}${usage}`;
};

const formatRuns = (runs: ReadonlyArray<RunSummary>) =>
  runs.length === 0 ? "(no runs recorded)" : ["runs:", ...runs.map(formatRun)].join("\n");

const formatEvent = (event: RunEvent) =>
  `  #${event.seq}  ${event.type}${event.name ? ` ${event.name}` : ""}  ${event.data}`;

const formatEvents = (events: ReadonlyArray<RunEvent>) =>
  events.length === 0 ? "(no events for this run)" : events.map(formatEvent).join("\n");

const overSocket = <E, R>(effect: Effect.Effect<void, E, R>, socketPath: string) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(clientLayer(socketPath)),
    Effect.tapError((error) =>
      Console.error(`Could not reach clanker-forge daemon at ${socketPath}: ${String(error)}`),
    ),
  );

const runRuns = Effect.fn("commands.runRuns")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    const runs = yield* client.ListRuns();
    yield* Console.log(formatRuns(runs));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runEvents = Effect.fn("commands.runEvents")(
  function* (options: { readonly socketPath: string; readonly id: string }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    const id = yield* Schema.decodeUnknownEffect(RunId)(options.id);
    const events = yield* client.GetRunEvents({ id });
    yield* Console.log(formatEvents(events));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const watchPayload = (id: Option.Option<string>) => {
  const raw = Option.getOrUndefined(id);
  if (raw === undefined) return Effect.succeed({});
  return Effect.map(Schema.decodeUnknownEffect(RunId)(raw), (value) => ({ id: value }));
};

const runWatch = Effect.fn("commands.runWatch")(
  function* (options: { readonly socketPath: string; readonly id: Option.Option<string> }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    const payload = yield* watchPayload(options.id);
    yield* client.WatchActivity(payload).pipe(
      Stream.mapAccum(() => initialWatchState, stepWatch, { onHalt: flushWatch }),
      Stream.runForEach(Console.log),
    );
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runStatus = Effect.fn("commands.runStatus")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    const status = yield* client.GetStatus();
    yield* Console.log(formatStatus(status));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

export const daemonCommand = Command.make("daemon", {
  socket: socketFlag,
  configHome: configHomeFlag,
  ledger: ledgerFlag,
  maxConcurrency: maxConcurrencyFlag,
  dailyBudget: dailyBudgetFlag,
  pollInterval: pollIntervalFlag,
}).pipe(
  Command.withHandler(({ socket, configHome, ledger, maxConcurrency, dailyBudget, pollInterval }) =>
    runDaemon({
      socketPath: socket,
      configHome,
      ledgerPath: ledger,
      maxConcurrency,
      dailyBudget,
      pollIntervalMillis: pollInterval * 1000,
    }),
  ),
);

export const statusCommand = Command.make("status", { socket: socketFlag }).pipe(
  Command.withHandler(({ socket }) => runStatus({ socketPath: socket })),
);

export const runsCommand = Command.make("runs", { socket: socketFlag }).pipe(
  Command.withHandler(({ socket }) => runRuns({ socketPath: socket })),
);

export const runEventsCommand = Command.make("run-events", { socket: socketFlag, id: runIdFlag }).pipe(
  Command.withHandler(({ socket, id }) => runEvents({ socketPath: socket, id })),
);

export const watchCommand = Command.make("watch", { socket: socketFlag, id: watchIdFlag }).pipe(
  Command.withHandler(({ socket, id }) => runWatch({ socketPath: socket, id })),
);
