import {
  applyDaemonEvent,
  type Board,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ControlStore,
  type DaemonEvent,
  type DaemonStatus,
  initialBoard,
  ModelOptionSelections,
  type OperationSettingContext,
  OperationSettingName,
  type OperationSettingRefused,
  OperationSettingUpdate,
  operationSettingNames,
  type RunActivity,
  type RunEvent,
  type RunHistory,
  RunId,
  type RunSummary,
  RunWatchItem,
  resolveOperationSetting,
  type SchedulingState,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { Daemon, Registry, readControlStore } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { SocketErrorReason, SocketOpenError } from "effect/socket/Socket";
import { defaultControlStorePath, defaultCredentialsPath, defaultSocketPath } from "./paths";
import { installProcessProfileIpc } from "./process-profile-ipc";
import { clientLayer, type DaemonOptions, type DaemonRpcTimeout, makeDaemonClient, serverLayer } from "./rpc";
import { formatDaemonLimits, formatOfflineStatus, formatStatus, formatStatusWithStore } from "./status";
import { secondStopSignal } from "./stop-signal";
import { telemetryLayer } from "./telemetry";
import { terminalLine } from "./terminal-text";
import { flushWatch, initialWatchState, renderBoard, stepWatch } from "./watch";

const defaultPollInterval = Duration.minutes(1);
const defaultDrainGrace = Duration.minutes(5);

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const controlStoreFlag = Flag.String("control-store").pipe(
  Flag.withDescription("Path to the machine-local Control store"),
  Flag.withDefault(defaultControlStorePath),
);

const credentialsFlag = Flag.String("credentials").pipe(
  Flag.withDescription("Path to the stored OAuth credential file (0600)"),
  Flag.withDefault(defaultCredentialsPath),
);

const pollIntervalFlag = Flag.Int("poll-interval").pipe(
  Flag.withDescription("Seconds between issue-tracker polls (higher values conserve GitHub API quota)"),
  Flag.withDefault(Duration.toSeconds(defaultPollInterval)),
);

const drainGraceFlag = Flag.Int("drain-grace").pipe(
  Flag.withDescription(
    "Seconds in-flight runs get to finish after a stop signal (a second signal ends the wait)",
  ),
  Flag.withDefault(Duration.toSeconds(defaultDrainGrace)),
);

const telemetryFlag = Flag.Literals("telemetry", ["on", "off"]).pipe(Flag.withDefault("on"));
const performanceWorkspaceFlag = Flag.String("performance-workspace").pipe(
  Flag.withDescription("Workspace that receives machine-local performance evidence"),
  Flag.optional,
);

const runIdFlag = Flag.String("id").pipe(Flag.withDescription("Run id to inspect"));

const watchIdFlag = Flag.String("id").pipe(
  Flag.withDescription("Follow a single run id directly"),
  Flag.optional,
);

const watchWorkItemArg = Argument.String("work-item").pipe(
  Argument.withDescription("Work item to watch; resolves to its running run, else its most recent run"),
  Argument.optional,
);

const daemonLimitKeyArgument = Argument.Literals("limit", [
  "global-concurrency",
  "per-workspace-concurrency",
  "daily-budget",
]);

const daemonLimitValueArgument = Argument.Int("value");
const contributionSettingArgument = Argument.String("contribution");
const contributionSettingValueArgument = Argument.Literals("value", ["on", "off"]);
const contributionSettingScopeFlag = Flag.Literals("scope", ["profile", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const contributionSettingWorkspaceFlag = Flag.String("workspace").pipe(Flag.optional);
const operationSettingArgument = Argument.Literals("setting", OperationSettingName.literals);
const operationSettingValueArgument = Argument.String("value");
const operationSettingScopeFlag = Flag.Literals("scope", ["profile", "host", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const operationSettingWorkspaceFlag = Flag.String("workspace").pipe(Flag.optional);

export { formatDaemonLimits } from "./status";

const isUnavailableDaemonError = (error: unknown) =>
  Schema.is(SocketOpenError)(error) ||
  (Schema.is(RpcClientError)(error) && Schema.is(SocketOpenError)(error.reason));

const isDaemonTransportError = (error: unknown) =>
  Schema.is(SocketErrorReason)(error) ||
  (Schema.is(RpcClientError)(error) && Schema.is(SocketErrorReason)(error.reason));

export const daemonOrStore = <A, E, R, E2, R2>(
  daemon: Effect.Effect<A, E | RpcClientError, R>,
  store: Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E | E2 | RpcClientError, R | R2> =>
  Effect.catchIf(daemon, isUnavailableDaemonError, () => store);

type ResolvedOperationSettingValue = ReturnType<typeof resolveOperationSetting>;

const isEmptyArray = (value: ResolvedOperationSettingValue) =>
  Array.isArray(value) ? value.length === 0 : false;

const operationSettingFormatRules: ReadonlyArray<{
  readonly when: (value: ResolvedOperationSettingValue) => boolean;
  readonly format: (value: ResolvedOperationSettingValue) => string;
}> = [
  { when: (value) => value === null, format: () => "unset" },
  { when: isEmptyArray, format: () => "unset" },
  {
    when: (value) => typeof value === "object",
    format: (value) => JSON.stringify(value),
  },
  { when: () => true, format: String },
];

const formatOperationSettingValue = (value: ResolvedOperationSettingValue) =>
  operationSettingFormatRules.find(({ when }) => when(value))?.format(value) ?? "unset";

export const formatOperationSettings = (controlStore: ControlStore, context: OperationSettingContext) =>
  operationSettingNames
    .map((setting) =>
      [
        setting,
        formatOperationSettingValue(
          resolveOperationSetting(controlStore.operationSettings, setting, context),
        ),
      ].join(": "),
    )
    .join("\n");

class ContributionSettingInputError extends Data.TaggedError("ContributionSettingInputError")<{
  readonly message: string;
}> {}

const decodeContributionSettingUpdateInput = Schema.decodeUnknownEffect(ContributionSettingUpdate);
const decodeOperationSettingUpdateInput = Schema.decodeUnknownEffect(OperationSettingUpdate);
const decodeModelOptionSelections = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelOptionSelections));
const operationSettingInputError = (message: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: terminalLine(message) });

interface ContributionSettingOptions {
  readonly contribution: string;
  readonly scope: "profile" | "overlay";
  readonly workspace: Option.Option<string>;
}

const contributionSettingScope = (options: ContributionSettingOptions) =>
  options.scope === "profile"
    ? { _tag: "SettingsProfile" }
    : {
        _tag: "PrivateWorkspaceOverlay",
        workspace: Option.getOrElse(options.workspace, () => ""),
      };

const decodeContributionSettingUpdate = (input: unknown) =>
  decodeContributionSettingUpdateInput(input).pipe(
    Effect.mapError((error) => new ContributionSettingInputError({ message: error.message })),
  );

export const makeContributionSettingUpdate = (
  options: ContributionSettingOptions,
  value: Option.Option<"on" | "off">,
) => {
  const cell = {
    contribution: { id: options.contribution, kind: "mcp-server" },
    scope: contributionSettingScope(options),
  };
  if (Option.isNone(value)) return decodeContributionSettingUpdate({ _tag: "Clear", cell });
  return decodeContributionSettingUpdate({
    _tag: "Set",
    row: { ...cell, enabled: value.value === "on" },
  });
};

interface OperationSettingOptions {
  readonly setting: OperationSettingName;
  readonly scope: "profile" | "host" | "overlay";
  readonly workspace: Option.Option<string>;
}

const operationSettingScope = (options: OperationSettingOptions) => {
  if (options.scope === "profile") return { _tag: "SettingsProfile" };
  if (options.scope === "host") return { _tag: "RuntimeHost" };
  return {
    _tag: "PrivateWorkspaceOverlay",
    workspace: Option.getOrElse(options.workspace, () => ""),
  };
};

const operationSettingCell = (options: OperationSettingOptions) => ({
  setting: options.setting,
  scope: operationSettingScope(options),
  level: { _tag: "Default" as const },
});

const operationSettingValueParsers: Record<
  OperationSettingName,
  (value: string) => Effect.Effect<unknown, CliError.UserError>
> = {
  harness: Effect.succeed,
  model: Effect.succeed,
  "model-options": (value: string) =>
    decodeModelOptionSelections(value).pipe(
      Effect.mapError((error) => operationSettingInputError(error.message, error)),
    ),
};

const operationSettingValue = (setting: OperationSettingName, value: string) =>
  operationSettingValueParsers[setting](value);

const decodeOperationSettingUpdate = (input: unknown) =>
  decodeOperationSettingUpdateInput(input).pipe(
    Effect.mapError((error) => operationSettingInputError(error.message, error)),
  );

const operationSettingContext = Effect.fn("commands.operationSettingContext")(function* (options: {
  readonly workspace: Option.Option<string>;
}) {
  const workspace = Option.isSome(options.workspace)
    ? yield* Schema.decodeEffect(WorkspaceId)(options.workspace.value)
    : null;
  return { workspace };
});

export const formatOperationSettingRefusal = (refusal: OperationSettingRefused) =>
  `${terminalLine(refusal.source)} refused ${refusal.setting}: ${terminalLine(refusal.reason)}`;

export const operationSettingError = (refusal: OperationSettingRefused) =>
  operationSettingInputError(formatOperationSettingRefusal(refusal), refusal);

export const makeOperationSettingUpdate = (
  options: OperationSettingOptions,
  value: Option.Option<string>,
) => {
  const cell = operationSettingCell(options);
  if (Option.isNone(value)) return decodeOperationSettingUpdate({ _tag: "Clear", cell });
  return operationSettingValue(options.setting, value.value).pipe(
    Effect.flatMap((settingValue) =>
      decodeOperationSettingUpdate({
        _tag: "Set",
        row: { ...cell, value: settingValue },
      }),
    ),
  );
};

export const schedulingActions = {
  pause: "paused",
  resume: "running",
} as const satisfies Record<"pause" | "resume", SchedulingState>;

const runDaemon = Effect.fn("commands.runDaemon")(
  function* (options: DaemonOptions) {
    const registry = yield* (yield* Registry.WorkspaceRegistry).state;
    yield* Effect.logInfo("cogwork daemon started", {
      socket: options.socketPath,
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
    });
    yield* Effect.forEach(
      registry.failures,
      (failure) =>
        Effect.logWarning("workspace registration failed", {
          workspace: failure.name,
          displayName: failure.displayName,
          source: failure.source,
          message: failure.message,
        }),
      { discard: true },
    );
    yield* installProcessProfileIpc();
    const abort = yield* secondStopSignal;
    yield* Daemon.heartbeats({
      pollIntervalMillis: options.pollIntervalMillis,
      drain: { graceMillis: options.drainGraceMillis, abort },
    });
  },
  (effect, options) =>
    effect.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          serverLayer(options),
          telemetryLayer({
            enabled: options.telemetryEnabled,
            maintenanceInterval: options.pollIntervalMillis,
          }),
          Metric.enableRuntimeMetricsLayer,
        ),
      ),
    ),
);

const usageLabel = (usage: RunSummary["usage"]) => {
  if (usage?.totalTokens === undefined) return "";
  return `  tokens=${usage.estimated ? "~" : ""}${usage.totalTokens}`;
};

const formatRun = (run: RunSummary) => {
  const session = run.session ? `  session=${run.session}` : "";
  const prunedHistoryLabel =
    run.eventsPrunedAtMillis === null ? "" : `  history-pruned=${run.eventsPrunedAtMillis}`;
  return `  ${run.id}  ${run.status}  ${run.operation}  ${run.workItem} [${run.harness}]  events=${run.eventCount}${prunedHistoryLabel}${session}${usageLabel(run.usage)}`;
};

const formatRuns = (runs: ReadonlyArray<RunSummary>) =>
  runs.length === 0 ? "(no runs recorded)" : ["runs:", ...runs.map(formatRun)].join("\n");

const formatEvent = (event: RunEvent) =>
  `  #${event.seq}  ${event.type}${event.name ? ` ${event.name}` : ""}  ${event.data}`;

export const formatRunEvents = (history: RunHistory) => {
  if (history.eventsPrunedAtMillis !== null) return `(run history pruned at ${history.eventsPrunedAtMillis})`;
  return history.events.length === 0
    ? "(no events for this run)"
    : history.events.map(formatEvent).join("\n");
};

export const reportDaemonTransportError = (socketPath: string, error: unknown) =>
  isDaemonTransportError(error)
    ? Console.error(`Could not reach cogwork daemon at ${socketPath}: ${String(error)}`)
    : Effect.void;

const overSocket = <E, R>(effect: Effect.Effect<void, E, R>, socketPath: string) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(clientLayer(socketPath)),
    Effect.tapError((error) => reportDaemonTransportError(socketPath, error)),
  );

const runRuns = Effect.fn("commands.runRuns")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* makeDaemonClient();
    const runs = yield* client.ListRuns();
    yield* Console.log(formatRuns(runs));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runMetrics = Effect.fn("commands.runMetrics")(
  function* (_options: { readonly socketPath: string }) {
    const client = yield* makeDaemonClient();
    const metrics = yield* client.GetMetrics();
    yield* Console.log(metrics === "" ? "(no metrics recorded)" : metrics);
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const runEvents = Effect.fn("commands.runEvents")(
  function* (options: { readonly socketPath: string; readonly id: string }) {
    const client = yield* makeDaemonClient();
    const id = yield* Schema.decodeEffect(RunId)(options.id);
    const history = yield* client.GetRunEvents({ id });
    yield* Console.log(formatRunEvents(history));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const markSeen = (seen: Ref.Ref<ReadonlyMap<string, number>>) => (activity: RunActivity) =>
  Ref.modify(seen, (map) => {
    const last = map.get(activity.runId) ?? -1;
    if (activity.seq <= last) return [false, map] as const;
    return [true, new Map(map).set(activity.runId, activity.seq)] as const;
  });

type WatchRpcError = DaemonRpcTimeout | RpcClientError;

const isWatchTransportError = (error: WatchRpcError) =>
  Schema.is(RpcClientError)(error) && Schema.is(SocketErrorReason)(error.reason);

export const watchReconnectBackoff = Schedule.exponential("500 millis", 2).pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(10)))),
  Schedule.setInputType<WatchRpcError>(),
  Schedule.while(({ input }) => isWatchTransportError(input)),
);

const clearScreen = "\u001b[2J\u001b[H";

type WatchPayload = { readonly id: RunId };

export const withWatchReconnect = <A, R>(stream: Stream.Stream<A, WatchRpcError, R>) =>
  stream.pipe(
    Stream.tapError((error) =>
      isWatchTransportError(error)
        ? Console.error(`watch: connection lost, reconnecting… (${String(error)})`)
        : Effect.void,
    ),
    Stream.retry(watchReconnectBackoff),
  );

const watchStream = (
  source: Stream.Stream<RunWatchItem, WatchRpcError>,
  seen: Ref.Ref<ReadonlyMap<string, number>>,
) =>
  withWatchReconnect(
    source.pipe(
      Stream.filter(RunWatchItem.guards.RunActivity),
      Stream.map((item) => item.activity),
      Stream.filterEffect(markSeen(seen)),
    ),
  );

const overviewScreen = (board: Board) => `${clearScreen}${renderBoard(board).join("\n")}`;

const watchOverview = (source: Stream.Stream<DaemonEvent, WatchRpcError>) =>
  withWatchReconnect(source.pipe(Stream.scan(() => initialBoard, applyDaemonEvent))).pipe(
    Stream.runForEach((board) => Console.log(overviewScreen(board))),
  );

export const daemonStatusPicture = Effect.fn("commands.daemonStatusPicture")(function* <E, R>(
  status: DaemonStatus,
  controlStore: Effect.Effect<ControlStore, E, R>,
) {
  if (status.health === "store-unavailable") return formatStatus(status);
  return formatStatusWithStore(status, yield* controlStore);
});

export const resolveTarget = Effect.fn("commands.resolveTarget")(function* <E, R>(
  resolve: (workItem: WorkItemId) => Effect.Effect<RunId | null, E, R>,
  id: Option.Option<string>,
  workItem: Option.Option<string>,
) {
  if (Option.isSome(id)) {
    return Option.some<WatchPayload>({ id: yield* Schema.decodeEffect(RunId)(id.value) });
  }
  if (Option.isNone(workItem)) return Option.none<WatchPayload>();
  const item = yield* Schema.decodeEffect(WorkItemId)(workItem.value);
  const runId = yield* resolve(item);
  return runId === null ? Option.none<WatchPayload>() : Option.some<WatchPayload>({ id: runId });
});

const runWatch = Effect.fn("commands.runWatch")(
  function* (options: {
    readonly socketPath: string;
    readonly id: Option.Option<string>;
    readonly workItem: Option.Option<string>;
  }) {
    const client = yield* makeDaemonClient();
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

const runStatus = Effect.fn("commands.runStatus")(function* (options: {
  readonly socketPath: string;
  readonly controlStorePath: string;
}) {
  yield* daemonOrStore(
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      const status = yield* client.GetStatus();
      return yield* daemonStatusPicture(status, client.GetControlStore());
    }).pipe(Effect.scoped, Effect.provide(clientLayer(options.socketPath))),
    readControlStore(options.controlStorePath).pipe(Effect.map(formatOfflineStatus)),
  ).pipe(Effect.flatMap(Console.log));
});

interface ControlStoreReadOptions {
  readonly socketPath: string;
  readonly controlStorePath: string;
}

const currentControlStore = (options: ControlStoreReadOptions) =>
  daemonOrStore(
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      return yield* client.GetControlStore();
    }).pipe(Effect.scoped, Effect.provide(clientLayer(options.socketPath))),
    readControlStore(options.controlStorePath),
  );

const showLimits = Effect.fn("commands.showLimits")(function* (options: ControlStoreReadOptions) {
  yield* currentControlStore(options).pipe(Effect.map(formatDaemonLimits), Effect.flatMap(Console.log));
});

const setLimit = Effect.fn("commands.setLimit")(
  function* (options: {
    readonly socketPath: string;
    readonly limit: "global-concurrency" | "per-workspace-concurrency" | "daily-budget";
    readonly value: number;
  }) {
    const client = yield* makeDaemonClient();
    const current = yield* client.GetControlStore();
    const controlStore = yield* client.SetDaemonLimit({
      update: {
        key: options.limit,
        value: options.value,
        expectedRevision: current.daemonLimits.revision,
      },
    });
    yield* Console.log(formatDaemonLimits(controlStore));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const showOperationSettings = Effect.fn("commands.showOperationSettings")(function* (options: {
  readonly socketPath: string;
  readonly controlStorePath: string;
  readonly workspace: Option.Option<string>;
}) {
  const context = yield* operationSettingContext(options);
  yield* currentControlStore(options).pipe(
    Effect.map((controlStore) => formatOperationSettings(controlStore, context)),
    Effect.flatMap(Console.log),
  );
});

export const formatContributionSettings = (controlStore: ControlStore) => {
  if (controlStore.contributionSettings.length === 0) return "(no contribution settings)";
  return controlStore.contributionSettings
    .map((row) => {
      const scope = ContributionSettingScope.match(row.scope, {
        SettingsProfile: () => "profile",
        PrivateWorkspaceOverlay: ({ workspace }) => `overlay:${workspace}`,
      });
      const diagnostic = row.diagnostic ? ` (${row.diagnostic._tag.toLowerCase()})` : "";
      return `${row.contribution.id} [${scope}]: ${row.enabled ? "on" : "off"}${diagnostic}`;
    })
    .join("\n");
};

const showContributionSettings = Effect.fn("commands.showContributionSettings")(function* (
  options: ControlStoreReadOptions,
) {
  yield* currentControlStore(options).pipe(
    Effect.map(formatContributionSettings),
    Effect.flatMap(Console.log),
  );
});

const changeContributionSetting = Effect.fn("commands.changeContributionSetting")(
  function* (
    options: ContributionSettingOptions & {
      readonly socketPath: string;
      readonly value: Option.Option<"on" | "off">;
    },
  ) {
    const client = yield* makeDaemonClient();
    const update = yield* makeContributionSettingUpdate(options, options.value);
    const controlStore = yield* client.SetContributionSetting({ update });
    yield* Console.log(formatContributionSettings(controlStore));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const changeOperationSetting = Effect.fn("commands.changeOperationSetting")(
  function* (
    options: OperationSettingOptions & {
      readonly socketPath: string;
      readonly value: Option.Option<string>;
    },
  ) {
    const client = yield* makeDaemonClient();
    const update = yield* makeOperationSettingUpdate(options, options.value);
    const context = yield* operationSettingContext(options);
    yield* client.SetOperationSetting({ updates: [update] }).pipe(
      Effect.catchTag("OperationSettingRefused", (refusal) => Effect.fail(operationSettingError(refusal))),
      Effect.flatMap((controlStore) => Console.log(formatOperationSettings(controlStore, context))),
    );
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const setScheduling = Effect.fn("commands.setScheduling")(
  function* (options: { readonly socketPath: string; readonly desired: SchedulingState }) {
    const client = yield* makeDaemonClient();
    const scheduler = yield* client.SetScheduling({ desired: options.desired });
    yield* Console.log(`scheduling: ${scheduler.scheduling}`);
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

export const daemonCommand = Command.make("daemon", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
  credentials: credentialsFlag,
  pollInterval: pollIntervalFlag,
  drainGrace: drainGraceFlag,
  telemetry: telemetryFlag,
  performanceWorkspace: performanceWorkspaceFlag,
}).pipe(
  Command.withHandler(
    ({ socket, controlStore, credentials, pollInterval, drainGrace, telemetry, performanceWorkspace }) =>
      Effect.gen(function* () {
        const configuredPerformanceWorkspace = Option.isSome(performanceWorkspace)
          ? yield* Schema.decodeEffect(WorkspaceId)(performanceWorkspace.value)
          : undefined;
        yield* runDaemon({
          socketPath: socket,
          controlStorePath: controlStore,
          credentialsPath: credentials,
          pollIntervalMillis: Duration.toMillis(Duration.seconds(pollInterval)),
          drainGraceMillis: Duration.toMillis(Duration.seconds(drainGrace)),
          telemetryEnabled: telemetry === "on",
          performanceWorkspace: configuredPerformanceWorkspace,
        });
      }),
  ),
);

export const statusCommand = Command.make("status", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    runStatus({ socketPath: socket, controlStorePath: controlStore }),
  ),
);

export const runsCommand = Command.make("runs", { socket: socketFlag }).pipe(
  Command.withHandler(({ socket }) => runRuns({ socketPath: socket })),
);

export const metricsCommand = Command.make("metrics", { socket: socketFlag }).pipe(
  Command.withDescription("Dump live daemon metrics"),
  Command.withHandler(({ socket }) => runMetrics({ socketPath: socket })),
);

export const runEventsCommand = Command.make("run-events", { socket: socketFlag, id: runIdFlag }).pipe(
  Command.withHandler(({ socket, id }) => runEvents({ socketPath: socket, id })),
);

export const watchCommand = Command.make("watch", {
  socket: socketFlag,
  id: watchIdFlag,
  workItem: watchWorkItemArg,
}).pipe(Command.withHandler(({ socket, id, workItem }) => runWatch({ socketPath: socket, id, workItem })));

const limitsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    showLimits({ socketPath: socket, controlStorePath: controlStore }),
  ),
);

const limitsSetCommand = Command.make("set", {
  socket: socketFlag,
  limit: daemonLimitKeyArgument,
  value: daemonLimitValueArgument,
}).pipe(Command.withHandler(({ socket, limit, value }) => setLimit({ socketPath: socket, limit, value })));

export const limitsCommand = Command.make("limits").pipe(
  Command.withSubcommands([limitsShowCommand, limitsSetCommand]),
);

const operationSettingsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
  workspace: operationSettingWorkspaceFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore, workspace }) =>
    showOperationSettings({
      socketPath: socket,
      controlStorePath: controlStore,
      workspace,
    }),
  ),
);

const operationSettingOptions = {
  socket: socketFlag,
  setting: operationSettingArgument,
  scope: operationSettingScopeFlag,
  workspace: operationSettingWorkspaceFlag,
};

const operationSettingsSetCommand = Command.make("set", {
  ...operationSettingOptions,
  value: operationSettingValueArgument,
}).pipe(
  Command.withHandler(({ socket, value, ...options }) =>
    changeOperationSetting({ socketPath: socket, ...options, value: Option.some(value) }),
  ),
);

const operationSettingsClearCommand = Command.make("clear", operationSettingOptions).pipe(
  Command.withHandler(({ socket, ...options }) =>
    changeOperationSetting({ socketPath: socket, ...options, value: Option.none() }),
  ),
);

export const operationSettingsCommand = Command.make("operation-settings").pipe(
  Command.withDescription("Show, set, or clear Operation settings"),
  Command.withSubcommands([
    operationSettingsShowCommand,
    operationSettingsSetCommand,
    operationSettingsClearCommand,
  ]),
);

const contributionSettingsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    showContributionSettings({ socketPath: socket, controlStorePath: controlStore }),
  ),
);

const contributionSettingOptions = {
  socket: socketFlag,
  contribution: contributionSettingArgument,
  scope: contributionSettingScopeFlag,
  workspace: contributionSettingWorkspaceFlag,
};

const contributionSettingsSetCommand = Command.make("set", {
  ...contributionSettingOptions,
  value: contributionSettingValueArgument,
}).pipe(
  Command.withHandler(({ socket, value, ...options }) =>
    changeContributionSetting({ socketPath: socket, ...options, value: Option.some(value) }),
  ),
);

const contributionSettingsClearCommand = Command.make("clear", contributionSettingOptions).pipe(
  Command.withHandler(({ socket, ...options }) =>
    changeContributionSetting({ socketPath: socket, ...options, value: Option.none() }),
  ),
);

export const contributionSettingsCommand = Command.make("contribution-settings").pipe(
  Command.withDescription("Show, set, or clear contribution settings"),
  Command.withSubcommands([
    contributionSettingsShowCommand,
    contributionSettingsSetCommand,
    contributionSettingsClearCommand,
  ]),
);

const schedulingPauseCommand = Command.make("pause", { socket: socketFlag }).pipe(
  Command.withDescription("Pause new runs; in-flight runs finish"),
  Command.withHandler(({ socket }) =>
    setScheduling({ socketPath: socket, desired: schedulingActions.pause }),
  ),
);

const schedulingResumeCommand = Command.make("resume", { socket: socketFlag }).pipe(
  Command.withDescription("Resume scheduling new runs"),
  Command.withHandler(({ socket }) =>
    setScheduling({ socketPath: socket, desired: schedulingActions.resume }),
  ),
);

export const schedulingCommand = Command.make("scheduling").pipe(
  Command.withDescription("Control new-run scheduling"),
  Command.withSubcommands([schedulingPauseCommand, schedulingResumeCommand]),
);
