import {
  applyDaemonEvent,
  type Board,
  ContributionSettingScope,
  ContributionSettingUpdate,
  type ControlStore,
  type DaemonEvent,
  type DaemonStatus,
  initialBoard,
  type OperationSettingContext,
  type OperationSettingName,
  OperationSettingUpdate,
  operationSettingNames,
  type RunActivity,
  type RunEvent,
  RunId,
  type RunSummary,
  resolveOperationSetting,
  type SchedulingState,
  WorkItemId,
  WorkspaceId,
} from "@cogwork/contracts";
import { Daemon, Registry, readControlStore } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { SocketErrorReason, SocketOpenError } from "effect/unstable/socket/Socket";
import { defaultControlStorePath, defaultCredentialsPath, defaultSocketPath } from "./paths";
import { installProcessProfileIpc } from "./process-profile-ipc";
import { clientLayer, type DaemonOptions, type DaemonRpcTimeout, makeDaemonClient, serverLayer } from "./rpc";
import { formatDaemonLimits, formatOfflineStatus, formatStatus, formatStatusWithStore } from "./status";
import { secondStopSignal } from "./stop-signal";
import { telemetryLayer } from "./telemetry";
import { flushWatch, initialWatchState, renderBoard, stepWatch } from "./watch";

const defaultPollInterval = Duration.minutes(1);
const defaultDrainGrace = Duration.minutes(5);

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

const pollIntervalFlag = Flag.integer("poll-interval").pipe(
  Flag.withDescription("Seconds between issue-tracker polls (higher values conserve GitHub API quota)"),
  Flag.withDefault(Duration.toSeconds(defaultPollInterval)),
);

const drainGraceFlag = Flag.integer("drain-grace").pipe(
  Flag.withDescription(
    "Seconds in-flight runs get to finish after a stop signal (a second signal ends the wait)",
  ),
  Flag.withDefault(Duration.toSeconds(defaultDrainGrace)),
);

const telemetryFlag = Flag.choice("telemetry", ["on", "off"]).pipe(Flag.withDefault("on"));
const performanceWorkspaceFlag = Flag.string("performance-workspace").pipe(
  Flag.withDescription("Workspace that receives machine-local performance evidence"),
  Flag.optional,
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

const daemonLimitKeyArgument = Argument.choice("limit", [
  "global-concurrency",
  "per-workspace-concurrency",
  "daily-budget",
]);

const daemonLimitValueArgument = Argument.integer("value");
const contributionSettingArgument = Argument.string("contribution");
const contributionSettingValueArgument = Argument.choice("value", ["on", "off"]);
const contributionSettingScopeFlag = Flag.choice("scope", ["profile", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const contributionSettingWorkspaceFlag = Flag.string("workspace").pipe(Flag.optional);
const operationSettingArgument = Argument.choice("setting", [
  "enabled",
  "harness",
  "model",
  "effort",
  "permission-profile",
  "bindings",
]);
const operationSettingValueArgument = Argument.string("value");
const operationSettingScopeFlag = Flag.choice("scope", ["profile", "host", "overlay"]).pipe(
  Flag.withDefault("profile"),
);
const operationSettingLevelFlag = Flag.choice("level", ["default", "workflow", "operation"]).pipe(
  Flag.withDefault("default"),
);
const operationSettingWorkflowFlag = Flag.string("workflow").pipe(Flag.withDefault("coding"));
const operationSettingOperationFlag = Flag.string("operation").pipe(Flag.withDefault("implement"));
const operationSettingWorkspaceFlag = Flag.string("workspace").pipe(Flag.optional);

export { formatDaemonLimits } from "./status";

const isUnavailableDaemonError = (error: unknown) =>
  Schema.is(SocketOpenError)(error) ||
  (Schema.is(RpcClientError)(error) && Schema.is(SocketOpenError)(error.reason));

export const daemonOrStore = <A, E, R, E2, R2>(
  daemon: Effect.Effect<A, E | RpcClientError, R>,
  store: Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E | E2 | RpcClientError, R | R2> =>
  Effect.catchIf(daemon, isUnavailableDaemonError, () => store);

const formatOperationSettingValue = (value: ReturnType<typeof resolveOperationSetting>) => {
  if (value === null) return "unset";
  if (Array.isArray(value)) return value.length === 0 ? "unset" : JSON.stringify(value);
  return String(value);
};

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

class OperationSettingInputError extends Data.TaggedError("OperationSettingInputError")<{
  readonly message: string;
}> {}

class ContributionSettingInputError extends Data.TaggedError("ContributionSettingInputError")<{
  readonly message: string;
}> {}

const decodeContributionSettingUpdateInput = Schema.decodeUnknownEffect(ContributionSettingUpdate);
const decodeOperationSettingUpdateInput = Schema.decodeUnknownEffect(OperationSettingUpdate);

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
  readonly level: "default" | "workflow" | "operation";
  readonly workflow: string;
  readonly operation: string;
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

const operationSettingLevel = (options: OperationSettingOptions) => {
  if (options.level === "default") return { _tag: "Default" };
  if (options.level === "workflow") return { _tag: "Workflow", workflow: options.workflow };
  return { _tag: "Operation", workflow: options.workflow, operation: options.operation };
};

const operationSettingCell = (options: OperationSettingOptions) => ({
  setting: options.setting,
  scope: operationSettingScope(options),
  level: operationSettingLevel(options),
});

const bindingValue = (value: string) =>
  value.split(",").map((entry) => {
    const [need = "", ...contribution] = entry.split("=");
    return { need, contribution: contribution.join("=") };
  });

const operationSettingValue = (setting: OperationSettingName, value: string) => {
  if (setting === "enabled") {
    if (value === "on") return true;
    if (value === "off") return false;
  }
  if (setting === "bindings") return bindingValue(value);
  return value;
};

const decodeOperationSettingUpdate = (input: unknown) =>
  decodeOperationSettingUpdateInput(input).pipe(
    Effect.mapError((error) => new OperationSettingInputError({ message: error.message })),
  );

const operationSettingContext = Effect.fn("commands.operationSettingContext")(function* (options: {
  readonly workflow: string;
  readonly operation: string;
  readonly workspace: Option.Option<string>;
}) {
  const workspace = Option.isSome(options.workspace)
    ? yield* Schema.decodeEffect(WorkspaceId)(options.workspace.value)
    : null;
  return { workflow: options.workflow, operation: options.operation, workspace };
});

export const makeOperationSettingUpdate = (
  options: OperationSettingOptions,
  value: Option.Option<string>,
) => {
  const cell = operationSettingCell(options);
  if (Option.isNone(value)) return decodeOperationSettingUpdate({ _tag: "Clear", cell });
  return decodeOperationSettingUpdate({
    _tag: "Set",
    row: { ...cell, value: operationSettingValue(options.setting, value.value) },
  });
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
    yield* Daemon.bootstrap;
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
  source: Stream.Stream<RunActivity, WatchRpcError>,
  seen: Ref.Ref<ReadonlyMap<string, number>>,
) => withWatchReconnect(source.pipe(Stream.filterEffect(markSeen(seen))));

const overviewScreen = (board: Board) => `${clearScreen}${renderBoard(board).join("\n")}`;

const watchOverview = (source: Stream.Stream<DaemonEvent, WatchRpcError>) =>
  withWatchReconnect(source.pipe(Stream.scan(initialBoard, applyDaemonEvent))).pipe(
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
  readonly workflow: string;
  readonly operation: string;
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
    const controlStore = yield* client.SetOperationSetting({ update });
    yield* Console.log(formatOperationSettings(controlStore, yield* operationSettingContext(options)));
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
  workflow: operationSettingWorkflowFlag,
  operation: operationSettingOperationFlag,
  workspace: operationSettingWorkspaceFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore, workflow, operation, workspace }) =>
    showOperationSettings({
      socketPath: socket,
      controlStorePath: controlStore,
      workflow,
      operation,
      workspace,
    }),
  ),
);

const operationSettingOptions = {
  socket: socketFlag,
  setting: operationSettingArgument,
  scope: operationSettingScopeFlag,
  level: operationSettingLevelFlag,
  workflow: operationSettingWorkflowFlag,
  operation: operationSettingOperationFlag,
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
