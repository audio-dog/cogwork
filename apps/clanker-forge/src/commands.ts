import { DaemonRpcs, type DaemonStatus } from "contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { Daemon, Registry } from "engine";
import { defaultConfigHome, defaultSocketPath } from "./paths";
import { clientLayer, serverLayer } from "./rpc";

const socketFlag = Flag.string("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const configHomeFlag = Flag.string("config-home").pipe(
  Flag.withDescription("Directory of workspace config files the daemon imports"),
  Flag.withDefault(defaultConfigHome),
);

const runDaemon = (options: { readonly socketPath: string; readonly configHome: string }) =>
  Effect.gen(function* () {
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
    yield* Daemon.reconcileHeartbeat;
  }).pipe(Effect.provide(serverLayer(options)));

const formatStatus = (status: DaemonStatus) => {
  const header = `daemon: ${status.health} (uptime ${Math.round(status.uptimeMillis / 1000)}s)`;
  const workspaces =
    status.workspaces.length === 0
      ? "  (no workspaces registered)"
      : status.workspaces
          .map((w) => `  - ${w.name} [${w.workSource}/${w.harness}] ${w.checkoutPath}`)
          .join("\n");
  const failures = status.failures.map((f) => `  ! ${f.source}: ${f.message}`).join("\n");
  return [
    header,
    "workspaces:",
    workspaces,
    ...(status.failures.length > 0 ? ["failures:", failures] : []),
  ].join("\n");
};

const runStatus = (options: { readonly socketPath: string }) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(DaemonRpcs);
    const status = yield* client.GetStatus();
    yield* Console.log(formatStatus(status));
  }).pipe(
    Effect.scoped,
    Effect.provide(clientLayer(options.socketPath)),
    Effect.tapError((error) =>
      Console.error(`Could not reach clanker-forge daemon at ${options.socketPath}: ${String(error)}`),
    ),
  );

export const daemonCommand = Command.make("daemon", {
  socket: socketFlag,
  configHome: configHomeFlag,
}).pipe(Command.withHandler(({ socket, configHome }) => runDaemon({ socketPath: socket, configHome })));

export const statusCommand = Command.make("status", { socket: socketFlag }).pipe(
  Command.withHandler(({ socket }) => runStatus({ socketPath: socket })),
);
