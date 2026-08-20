// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { codexRunner } from "@cogwork/codex-cli";
import { HarnessName } from "@cogwork/contracts";
import { cursorRunner } from "@cogwork/cursor-acp";
import { ContextAssembler, Daemon, Provider, Registry } from "@cogwork/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { layer as credentialsLayer } from "./credentials";
import { layer as ledgerLayer } from "./ledger";
import { loadFromDisk } from "./loader";
import { contextFsLayer, worktreeManagerLayer } from "./platform";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly configHome: string;
  readonly ledgerPath: string;
  readonly credentialsPath: string;
  readonly maxConcurrency: number;
  readonly maxPerWorkspace: number;
  readonly dailyBudget: number;
  readonly pollIntervalMillis: number;
  readonly drainGraceMillis: number;
  readonly startPaused: boolean;
}

const prepareSocketDir = (socketPath: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = path.dirname(socketPath);
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 });
    yield* fs.chmod(dir, 0o700);
  });

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

const boundSocketServer = (socketPath: string) =>
  prepareSocketDir(socketPath).pipe(
    Effect.andThen(clearStaleSocket(socketPath)),
    Effect.map(() => NodeSocketServer.layer({ path: socketPath })),
    Layer.unwrap,
  );

const restrictSocket = (socketPath: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      // Depend on SocketServer so this chmod runs after the bind creates the socket, never before.
      yield* SocketServer.SocketServer;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.chmod(socketPath, 0o600);
    }),
  );

export const transportLayer = (socketPath: string) =>
  RpcServer.layerProtocolSocketServer.pipe(
    Layer.provide(restrictSocket(socketPath).pipe(Layer.provideMerge(boundSocketServer(socketPath)))),
  );

const registryLayer = (configHome: string) =>
  Layer.effect(Registry.WorkspaceRegistry, Effect.map(loadFromDisk(configHome), Registry.buildRegistry));

const cursorName = Schema.decodeSync(HarnessName)("cursor");
const codexName = Schema.decodeSync(HarnessName)("codex");
const providerName = Schema.decodeSync(HarnessName)("provider");

export const harnessRunners = [
  cursorRunner({ name: cursorName }),
  codexRunner({ name: codexName }),
  Provider.providerRunner({ name: providerName }),
];

// The engine ships the playbook skills beside its source, and the daemon home
// (where the global AGENTS.md and provisioned skills live) is the directory that
// holds the credentials file.
const engineSkillsDir = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.resolve("@cogwork/engine"))),
  "../skills",
);

const contextAssemblerLayer = (homeDir: string) =>
  ContextAssembler.layer({ homeDir, skillsDir: engineSkillsDir }).pipe(Layer.provide(contextFsLayer));

export const serverLayer = (options: DaemonOptions) =>
  Daemon.serverLayer({
    transport: transportLayer(options.socketPath),
    credentials: credentialsLayer(options.credentialsPath),
    contextAssembler: contextAssemblerLayer(nodePath.dirname(options.credentialsPath)),
    runLedger: ledgerLayer(options.ledgerPath),
    registry: registryLayer(options.configHome),
    worktrees: worktreeManagerLayer,
    harnessRunners,
    scheduler: {
      globalLimit: options.maxConcurrency,
      perWorkspaceLimit: options.maxPerWorkspace,
      dailyBudget: options.dailyBudget,
      startPaused: options.startPaused,
    },
  });

export const clientLayer = (socketPath: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(Daemon.serializationLayer),
  );
