import * as fs from "node:fs/promises";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { DaemonRpcs } from "contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { Daemon, Reconcile, Registry } from "engine";
import { loadFromDisk } from "./loader";

const socketServerLayer = (socketPath: string) =>
  Effect.promise(() => fs.rm(socketPath, { force: true })).pipe(
    Effect.map(() => NodeSocketServer.layer({ path: socketPath })),
    Layer.unwrap,
  );

const registryLayer = (configHome: string) =>
  Layer.effect(Registry.WorkspaceRegistry, Effect.map(loadFromDisk(configHome), Registry.buildRegistry));

export const serverLayer = (options: { readonly socketPath: string; readonly configHome: string }) => {
  const shared = Reconcile.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(registryLayer(options.configHome), Daemon.daemonInfoLayer)),
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
