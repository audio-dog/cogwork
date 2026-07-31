import { DaemonRpcs, HarnessName } from "@clanker-forge/contracts";
import { cursorRunner } from "@clanker-forge/cursor-acp";
import { Daemon, Executor, GitHub, Harness, Reconcile, Registry, Scheduler } from "@clanker-forge/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { layer as ledgerLayer } from "./ledger";
import { loadFromDisk } from "./loader";
import { worktreeManagerLayer } from "./platform";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly configHome: string;
  readonly ledgerPath: string;
  readonly maxConcurrency: number;
  readonly dailyBudget: number;
}

const clearStaleSocket = (socketPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(socketPath).pipe(Effect.orElseSucceed(() => null));
    if (info === null) return;
    if (info.type !== "Socket") {
      return yield* Effect.die(new Error(`Refusing to remove non-socket file at ${socketPath}`));
    }
    yield* fs.remove(socketPath, { force: true });
  });

const socketServerLayer = (socketPath: string) =>
  clearStaleSocket(socketPath).pipe(
    Effect.map(() => NodeSocketServer.layer({ path: socketPath })),
    Layer.unwrap,
  );

const registryLayer = (configHome: string) =>
  Layer.effect(Registry.WorkspaceRegistry, Effect.map(loadFromDisk(configHome), Registry.buildRegistry));

const workSourceLayer = GitHub.adapterLayer.pipe(
  Layer.provide(GitHub.clientLayer),
  Layer.provide(FetchHttpClient.layer),
);

const cursorName = Schema.decodeSync(HarnessName)("cursor");
const harnessLayer = Harness.layer([cursorRunner({ name: cursorName })]);

const sharedLayer = (options: DaemonOptions) => {
  const base = Layer.mergeAll(
    registryLayer(options.configHome),
    Daemon.daemonInfoLayer,
    workSourceLayer,
    ledgerLayer(options.ledgerPath),
    harnessLayer,
  );
  const services = Layer.mergeAll(Reconcile.layer, Executor.layer, worktreeManagerLayer).pipe(
    Layer.provideMerge(base),
  );
  return Scheduler.layer({
    globalLimit: options.maxConcurrency,
    dailyBudget: options.dailyBudget,
  }).pipe(Layer.provideMerge(services));
};

export const serverLayer = (options: DaemonOptions) =>
  RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(Daemon.handlersLayer),
    Layer.provideMerge(RpcServer.layerProtocolSocketServer),
    Layer.provide(socketServerLayer(options.socketPath)),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provideMerge(sharedLayer(options)),
  );

export const clientLayer = (socketPath: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(RpcSerialization.layerNdjson),
  );
