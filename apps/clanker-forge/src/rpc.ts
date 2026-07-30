import * as fs from "node:fs/promises";
import { DaemonRpcs } from "@clanker-forge/contracts";
import { Daemon, Reconcile, Registry, WorkSource } from "@clanker-forge/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { loadFromDisk } from "./loader";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly configHome: string;
}

const clearStaleSocket = (socketPath: string) =>
  Effect.gen(function* () {
    const stat = yield* Effect.promise(() => fs.stat(socketPath).catch(() => null));
    if (stat === null) return;
    if (!stat.isSocket()) {
      return yield* Effect.die(new Error(`Refusing to remove non-socket file at ${socketPath}`));
    }
    yield* Effect.promise(() => fs.rm(socketPath, { force: true }));
  });

const socketServerLayer = (socketPath: string) =>
  clearStaleSocket(socketPath).pipe(
    Effect.map(() => NodeSocketServer.layer({ path: socketPath })),
    Layer.unwrap,
  );

const registryLayer = (configHome: string) =>
  Layer.effect(Registry.WorkspaceRegistry, Effect.map(loadFromDisk(configHome), Registry.buildRegistry));

export const serverLayer = (options: DaemonOptions) => {
  const shared = Reconcile.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(registryLayer(options.configHome), Daemon.daemonInfoLayer, WorkSource.emptyLayer),
    ),
  );
  return RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(Daemon.handlersLayer),
    Layer.provideMerge(RpcServer.layerProtocolSocketServer),
    Layer.provide(socketServerLayer(options.socketPath)),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provideMerge(shared),
  );
};

export const clientLayer = (socketPath: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(RpcSerialization.layerNdjson),
  );
