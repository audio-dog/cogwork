import {
  applyDaemonEvent,
  type Board,
  type DaemonEvent,
  DaemonRpcs,
  defaultSchedulerDailyBudget,
  defaultSchedulerGlobalLimit,
  defaultSchedulerPerWorkspaceLimit,
  initialBoard,
  type RunActivity,
  type RunEvent,
  RunId,
  type RunSummary,
  WorkItemId,
} from "@cogwork/contracts";
import { Daemon, Registry } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { defaultControlStorePath, defaultCredentialsPath, defaultSocketPath } from "./paths";
import { clientLayer, type DaemonOptions, serverLayer } from "./rpc";
import { formatStatus } from "./status";
import { secondStopSignal } from "./stop-signal";
import { telemetryLayer } from "./telemetry";
import { flushWatch, initialWatchState, renderBoard, stepWatch } from "./watch";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const controlStoreFlag = Flag.string("control-store").pipe(
  Flag.withDescription("Path to the machine-local Control store"),
  Flag.withDefault(defaultControlStorePath),
);

const credentialsFlag = Flag.string("credentials").pipe(
  Flag.withDescription("Path to the stored OAuth credential file (0600)"),
  Flag.withDefault(defaultCredentialsPath),
);

const maxConcurrencyFlag = Flag.integer("max-concurrency").pipe(
  Flag.withDescription("Maximum concurrent agent sessions across all workspaces"),
  Flag.withDefault(defaultSchedulerGlobalLimit),
);

const maxPerWorkspaceFlag = Flag.integer("max-per-workspace").pipe(
  Flag.withDescription("Maximum concurrent agent sessions inside a single workspace"),
  Flag.withDefault(defaultSchedulerPerWorkspaceLimit),
);

const dailyBudgetFlag = Flag.integer("daily-budget").pipe(
  Flag.withDescription("Maximum agent sessions started per UTC day across all workspaces"),
  Flag.withDefault(defaultSchedulerDailyBudget),
);

const pollIntervalFlag = Flag.integer("poll-interval").pipe(
  Flag.withDescription("Seconds between issue-tracker polls (higher values conserve GitHub API quota)"),
  Flag.withDefault(60),
);

const drainGraceFlag = Flag.integer("drain-grace").pipe(
  Flag.withDescription(
    "Seconds in-flight runs get to finish after a stop signal (a second signal ends the wait)",
  ),
  Flag.withDefault(300),
);

const startPausedFlag = Flag.boolean("start-paused").pipe(
  Flag.withDescription("Start with scheduling paused until it is resumed (the desktop launch default)"),
  Flag.withDefault(false),
);

const runIdFlag = Flag.string("id").pipe(Flag.withDescription("Run id to inspect"));

const watchIdFlag = Flag.string("id").pipe(
  Flag.withDescription("Follow a single run id directly"),
  Flag.optional,
);

const watchWorkItemArg = Argument.string("work-item").pipe(
  Argument.withDescription("Work item to watch; resolves to its running run, else its most recent run"),
  Argument.optional,
);

const runDaemon = Effect.fn("commands.runDaemon")(
  function* (options: DaemonOptions) {
    const registry = yield* Registry.WorkspaceRegistry;
    yield* Effect.logInfo("cogwork daemon started", {
      socket: options.socketPath,
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
    const abort = yield* secondStopSignal;
    yield* Daemon.heartbeats({
      pollIntervalMillis: options.pollIntervalMillis,
      drain: { graceMillis: options.drainGraceMillis, abort },
    });
  },
  (effect, options) =>
    effect.pipe(Effect.scoped, Effect.provide(Layer.merge(serverLayer(options), telemetryLayer))),
);

const usageLabel = (usage: RunSummary["usage"]) => {
  if (usage?.totalTokens === undefined) return "";
  return `  tokens=${usage.estimated ? "~" : ""}${usage.totalTokens}`;
};

const formatRun = (run: RunSummary) => {
  const session = run.session ? `  session=${run.session}` : "";
  return `  ${run.id}  ${run.status}  ${run.stage}  ${run.workItem} [${run.harness}]  events=${run.eventCount}${session}${usageLabel(run.usage)}`;
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
      Console.error(`Could not reach cogwork daemon at ${socketPath}: ${String(error)}`),
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

const markSeen = (seen: Ref.Ref<ReadonlyMap<string, number>>) => (activity: RunActivity) =>
  Ref.modify(seen, (map) => {
    const last = map.get(activity.runId) ?? -1;
    if (activity.seq <= last) return [false, map] as const;
    return [true, new Map(map).set(activity.runId, activity.seq)] as const;
  });

const reconnectSchedule = Schedule.spaced("1 second");

const clearScreen = "\u001b[2J\u001b[H";

type WatchPayload = { readonly id: RunId };

const reconnecting = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.tapError((error) => Console.error(`watch: connection lost, reconnecting… (${String(error)})`)),
    Stream.retry(reconnectSchedule),
  );

const watchStream = <E>(source: Stream.Stream<RunActivity, E>, seen: Ref.Ref<ReadonlyMap<string, number>>) =>
  reconnecting(source.pipe(Stream.filterEffect(markSeen(seen))));

const overviewScreen = (board: Board) => `${clearScreen}${renderBoard(board).join("\n")}`;

const watchOverview = <E>(source: Stream.Stream<DaemonEvent, E>) =>
  reconnecting(source.pipe(Stream.scan(initialBoard, applyDaemonEvent))).pipe(
    Stream.runForEach((board) => Console.log(overviewScreen(board))),
  );

export const resolveTarget = Effect.fn("commands.resolveTarget")(function* <E, R>(
  resolve: (workItem: WorkItemId) => Effect.Effect<RunId | null, E, R>,
  id: Option.Option<string>,
  workItem: Option.Option<string>,
) {
  if (Option.isSome(id)) {
    return Option.some<WatchPayload>({ id: yield* Schema.decodeUnknownEffect(RunId)(id.value) });
  }
  if (Option.isNone(workItem)) return Option.none<WatchPayload>();
  const item = yield* Schema.decodeUnknownEffect(WorkItemId)(workItem.value);
  const runId = yield* resolve(item);
  return runId === null ? Option.none<WatchPayload>() : Option.some<WatchPayload>({ id: runId });
});

const runWatch = Effect.fn("commands.runWatch")(
  function* (options: {
    readonly socketPath: string;
    readonly id: Option.Option<string>;
    readonly workItem: Option.Option<string>;
  }) {
    const client = yield* RpcClient.make(DaemonRpcs);
    if (Option.isNone(options.id) && Option.isNone(options.workItem)) {
      return yield* watchOverview(client.WatchEvents());
    }
    const target = yield* resolveTarget(
      (workItem) => client.ResolveWatchTarget({ workItem }),
      options.id,
      options.workItem,
    );
    if (Option.isNone(target)) {
      const item = Option.getOrElse(options.workItem, () => "");
      return yield* Console.error(`watch: no runs found for ${item}`);
    }
    const seen = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    yield* watchStream(client.WatchActivity(target.value), seen).pipe(
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
  controlStore: controlStoreFlag,
  credentials: credentialsFlag,
  maxConcurrency: maxConcurrencyFlag,
  maxPerWorkspace: maxPerWorkspaceFlag,
  dailyBudget: dailyBudgetFlag,
  pollInterval: pollIntervalFlag,
  drainGrace: drainGraceFlag,
  startPaused: startPausedFlag,
}).pipe(
  Command.withHandler(
    ({
      socket,
      controlStore,
      credentials,
      maxConcurrency,
      maxPerWorkspace,
      dailyBudget,
      pollInterval,
      drainGrace,
      startPaused,
    }) =>
      runDaemon({
        socketPath: socket,
        controlStorePath: controlStore,
        credentialsPath: credentials,
        maxConcurrency,
        maxPerWorkspace,
        dailyBudget,
        pollIntervalMillis: pollInterval * 1000,
        drainGraceMillis: drainGrace * 1000,
        startPaused,
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

export const watchCommand = Command.make("watch", {
  socket: socketFlag,
  id: watchIdFlag,
  workItem: watchWorkItemArg,
}).pipe(Command.withHandler(({ socket, id, workItem }) => runWatch({ socketPath: socket, id, workItem })));
