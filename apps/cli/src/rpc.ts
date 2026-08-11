import { HarnessName } from "@clanker-forge/contracts";
import { cursorRunner } from "@clanker-forge/cursor-acp";
import { Daemon, Registry } from "@clanker-forge/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { layer as credentialsLayer } from "./credentials";
import { layer as ledgerLayer } from "./ledger";
import { loadFromDisk } from "./loader";
import { worktreeManagerLayer } from "./platform";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly configHome: string;
  readonly ledgerPath: string;
  readonly credentialsPath: string;
  readonly maxConcurrency: number;
  readonly dailyBudget: number;
  readonly pollIntervalMillis: number;
  readonly drainGraceMillis: number;
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

const transportLayer = (socketPath: string) =>
  RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(
      clearStaleSocket(socketPath).pipe(
        Effect.map(() => NodeSocketServer.layer({ path: socketPath })),
        Layer.unwrap,
      ),
    ),
  );

const registryLayer = (configHome: string) =>
  Layer.effect(Registry.WorkspaceRegistry, Effect.map(loadFromDisk(configHome), Registry.buildRegistry));

const cursorName = Schema.decodeSync(HarnessName)("cursor");

export const serverLayer = (options: DaemonOptions) =>
  Daemon.serverLayer({
    transport: transportLayer(options.socketPath),
    credentials: credentialsLayer(options.credentialsPath),
    runLedger: ledgerLayer(options.ledgerPath),
    registry: registryLayer(options.configHome),
    worktrees: worktreeManagerLayer,
    harnessRunners: [cursorRunner({ name: cursorName })],
    scheduler: { globalLimit: options.maxConcurrency, dailyBudget: options.dailyBudget },
  });

export const clientLayer = (socketPath: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(Daemon.serializationLayer),
  );
