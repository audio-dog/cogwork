import { WorkspaceId } from "@cogwork/contracts";
import { Daemon, RegistryService } from "@cogwork/engine";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { controlStoreFlag, socketFlag } from "./commands";
import { defaultCredentialsPath } from "./paths";
import { installProcessProfileIpc } from "./process-profile-ipc";
import { type DaemonOptions, serverLayer } from "./rpc";
import { secondStopSignal } from "./stop-signal";
import { telemetryLayer } from "./telemetry";

const defaultPollInterval = Duration.minutes(1);
const defaultDrainGrace = Duration.minutes(5);

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

const runDaemon = Effect.fn("commands.runDaemon")(
  function* (options: DaemonOptions) {
    const registry = yield* (yield* RegistryService.WorkspaceRegistry).state;
    yield* Effect.logInfo("cogwork daemon started", {
      socket: options.socketPath,
      workspaces: registry.workspaces.length,
      failures: registry.failures.length,
    });
    yield* Effect.forEach(
      registry.failures,
      (failure) =>
        Effect.logWarning("workspace registration failed", {
          workspace: failure.id,
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
