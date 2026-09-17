import * as os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeRunner } from "@cogwork/claude-code";
import { codexRunner } from "@cogwork/codex-cli";
import { DaemonRpcs, HarnessName, type WorkspaceId } from "@cogwork/contracts";
import { cursorRunner } from "@cogwork/cursor-acp";
import { ContextAssembler, Daemon, PerformanceHealth, Replay } from "@cogwork/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tuple from "effect/Tuple";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { type FromClientEncoded, type FromServerEncoded, RequestId } from "effect/unstable/rpc/RpcMessage";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { layer as credentialsLayer } from "./credentials";
import { layer as ledgerLayer } from "./ledger";
import { defaultTelemetryStorePath } from "./paths";
import { readPerformanceHealthSnapshot } from "./performance-health";
import { contextFsLayer, gitLayer, worktreeManagerLayer } from "./platform";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly controlStorePath: string;
  readonly credentialsPath: string;
  readonly pollIntervalMillis: number;
  readonly drainGraceMillis: number;
  readonly telemetryEnabled: boolean;
  readonly performanceWorkspace?: WorkspaceId;
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

const cursorName = Schema.decodeSync(HarnessName)("cursor");
const claudeName = Schema.decodeSync(HarnessName)("claude");
const codexName = Schema.decodeSync(HarnessName)("codex");
const replayName = Schema.decodeSync(HarnessName)("replay");

const standardHarnessRunners = [
  cursorRunner({ name: cursorName }),
  claudeCodeRunner({ name: claudeName, authentication: { mode: "host" } }),
  codexRunner({ name: codexName, environment: process.env }),
];

export const harnessRunners = Config.option(Config.string("COGWORK_REPLAY_FIXTURE")).pipe(
  Effect.flatMap((fixturePath) =>
    Effect.forEach(Option.toArray(fixturePath), (path) =>
      Replay.replayRunner({ name: replayName, fixturePath: Effect.succeed(path) }),
    ),
  ),
  Effect.map((replayRunners) => [...standardHarnessRunners, ...replayRunners]),
);

const engineOperatingInstructionsDir = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.resolve("@cogwork/engine"))),
  "../operating-instructions",
);

const userAgentsDir = nodePath.join(os.homedir(), ".agents");

export const daemonRpcDeadline = "5 minutes";

export class DaemonRpcTimeout extends Schema.TaggedError<DaemonRpcTimeout>()("DaemonRpcTimeout", {
  rpc: Schema.String,
  deadline: Schema.String,
}) {
  override get message() {
    return `${this.rpc} did not answer within ${this.deadline}`;
  }
}

class DaemonDeadlineMiddleware extends RpcMiddleware.Service<DaemonDeadlineMiddleware>()(
  "@cogwork/cli/DaemonDeadlineMiddleware",
  { error: DaemonRpcTimeout },
) {}

const daemonClientRpcs = DaemonRpcs.middleware(DaemonDeadlineMiddleware);

export const makeDaemonClient = () => RpcClient.make(daemonClientRpcs);

type ClientDeadlineKeys = ReadonlyMap<number, ReadonlySet<string>>;

interface DeadlineRegistry {
  readonly claim: (clientId: number, key: string) => Effect.Effect<boolean>;
  readonly remove: (clientId: number, key: string) => Effect.Effect<void>;
  readonly removeClient: (clientId: number) => Effect.Effect<void>;
  readonly run: (clientId: number, key: string, effect: Effect.Effect<void>) => Effect.Effect<void>;
}

const deadlineKey = (clientId: number, requestId: string | number) => `${clientId}:${requestId}`;

const deadlineFailure = (tag: string, deadline: string) => {
  return new DaemonRpcTimeout({ rpc: tag, deadline });
};

const entriesWithoutKey = <K, V>(current: ReadonlyMap<K, V>, key: K) =>
  [...current].filter(([currentKey]) => currentKey !== key);

const replaceClientDeadlineKeys = (
  current: ClientDeadlineKeys,
  clientId: number,
  clientKeys: ReadonlySet<string>,
) => {
  const replacement = clientKeys.size === 0 ? [] : [Tuple.make(clientId, clientKeys)];
  return new Map([...entriesWithoutKey(current, clientId), ...replacement]);
};

const addDeadlineKey = (deadlineKeys: Ref.Ref<ClientDeadlineKeys>, clientId: number, key: string) =>
  Ref.update(deadlineKeys, (current) => {
    const clientKeys = new Set([...(current.get(clientId) ?? []), key]);
    return replaceClientDeadlineKeys(current, clientId, clientKeys);
  });

const claimDeadlineKey = (deadlineKeys: Ref.Ref<ClientDeadlineKeys>, clientId: number, key: string) =>
  Ref.modify(deadlineKeys, (current) => {
    const clientKeys = current.get(clientId);
    if (!clientKeys?.has(key)) return Tuple.make(false, current);
    const remainingKeys = new Set([...clientKeys].filter((currentKey) => currentKey !== key));
    return Tuple.make(true, replaceClientDeadlineKeys(current, clientId, remainingKeys));
  });

const takeClientDeadlineKeys = (deadlineKeys: Ref.Ref<ClientDeadlineKeys>, clientId: number) =>
  Ref.modify(deadlineKeys, (current) =>
    Tuple.make([...(current.get(clientId) ?? [])], replaceClientDeadlineKeys(current, clientId, new Set())),
  );

const cancelResponseDeadline = (
  deadlines: DeadlineRegistry,
  clientId: number,
  response: FromServerEncoded,
) => {
  if (response._tag === "Chunk") return deadlines.remove(clientId, deadlineKey(clientId, response.requestId));
  if (response._tag === "Exit") return deadlines.remove(clientId, deadlineKey(clientId, response.requestId));
  if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
    return deadlines.removeClient(clientId);
  }
  return Effect.void;
};

const sendInterrupt = (
  upstream: RpcClient.Protocol["Service"],
  clientId: number,
  requestId: string | number,
) => upstream.send(clientId, { _tag: "Interrupt", requestId } satisfies FromClientEncoded);

const notifyDeadline = (
  handlers: Ref.Ref<ReadonlyMap<number, (response: FromServerEncoded) => Effect.Effect<void>>>,
  clientId: number,
  requestId: string | number,
  encodedError: unknown,
) =>
  Ref.get(handlers).pipe(
    Effect.flatMap(
      (current) =>
        current.get(clientId)?.({
          _tag: "Exit",
          requestId: RequestId(requestId),
          exit: {
            _tag: "Failure",
            cause: [{ _tag: "Fail", error: encodedError }],
          },
        }) ?? Effect.void,
    ),
  );

function startDeadline(
  deadlines: DeadlineRegistry,
  handlers: Ref.Ref<ReadonlyMap<number, (response: FromServerEncoded) => Effect.Effect<void>>>,
  upstream: RpcClient.Protocol["Service"],
  encodeError: (error: DaemonRpcTimeout) => Effect.Effect<unknown, Schema.SchemaError>,
  deadline: Duration.Input,
  clientId: number,
  request: Extract<FromClientEncoded, { readonly _tag: "Request" }>,
) {
  const key = deadlineKey(clientId, request.id);
  return deadlines.run(
    clientId,
    key,
    Effect.sleep(deadline).pipe(
      Effect.andThen(deadlines.claim(clientId, key)),
      Effect.flatMap((claimed) => {
        if (!claimed) return Effect.void;
        return encodeError(deadlineFailure(request.tag, String(deadline))).pipe(
          Effect.orDie,
          Effect.flatMap((encodedError) =>
            notifyDeadline(handlers, clientId, request.id, encodedError).pipe(
              Effect.ensuring(
                sendInterrupt(upstream, clientId, request.id).pipe(
                  Effect.timeout("1 second"),
                  Effect.ignoreCause,
                ),
              ),
            ),
          ),
        );
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logError("RPC deadline fiber failed", { cause }),
      ),
    ),
  );
}

export const daemonRpcDeadlineLayer = (
  deadline: Duration.Input,
): Layer.Layer<RpcClient.Protocol, never, RpcClient.Protocol> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const upstream = yield* RpcClient.Protocol;
      const encodeError = Schema.encodeUnknownEffect(upstream.codecFor(DaemonRpcTimeout));
      const deadlineFibers = yield* FiberMap.make<string>();
      const deadlineKeys = yield* Ref.make<ClientDeadlineKeys>(new Map());
      const deadlineGate = Semaphore.makeUnsafe(1);
      const deadlines: DeadlineRegistry = {
        claim: (clientId, key) => deadlineGate.withPermits(1)(claimDeadlineKey(deadlineKeys, clientId, key)),
        remove: (clientId, key) =>
          deadlineGate.withPermits(1)(
            claimDeadlineKey(deadlineKeys, clientId, key).pipe(
              Effect.flatMap((claimed) => (claimed ? FiberMap.remove(deadlineFibers, key) : Effect.void)),
            ),
          ),
        removeClient: (clientId) =>
          deadlineGate.withPermits(1)(
            takeClientDeadlineKeys(deadlineKeys, clientId).pipe(
              Effect.flatMap((keys) =>
                Effect.forEach(keys, (key) => FiberMap.remove(deadlineFibers, key), { discard: true }),
              ),
            ),
          ),
        run: (clientId, key, effect) =>
          deadlineGate.withPermits(1)(
            addDeadlineKey(deadlineKeys, clientId, key).pipe(
              Effect.andThen(FiberMap.run(deadlineFibers, key, effect, { startImmediately: true })),
              Effect.asVoid,
            ),
          ),
      };
      const handlers = yield* Ref.make<
        ReadonlyMap<number, (response: FromServerEncoded) => Effect.Effect<void>>
      >(new Map());

      return {
        run: (clientId, handler) =>
          Ref.update(handlers, (current) => new Map(current).set(clientId, handler)).pipe(
            Effect.andThen(
              upstream.run(clientId, (response) =>
                cancelResponseDeadline(deadlines, clientId, response).pipe(Effect.andThen(handler(response))),
              ),
            ),
            Effect.ensuring(
              deadlines
                .removeClient(clientId)
                .pipe(
                  Effect.andThen(
                    Ref.update(handlers, (current) => new Map(entriesWithoutKey(current, clientId))),
                  ),
                ),
            ),
          ),
        send: (clientId, request, transferables) => {
          if (request._tag === "Interrupt") {
            return deadlines
              .remove(clientId, deadlineKey(clientId, request.requestId))
              .pipe(Effect.andThen(upstream.send(clientId, request, transferables)));
          }
          if (request._tag !== "Request") {
            return upstream.send(clientId, request, transferables);
          }
          return startDeadline(deadlines, handlers, upstream, encodeError, deadline, clientId, request).pipe(
            Effect.andThen(upstream.send(clientId, request, transferables)),
            Effect.onError(() => deadlines.remove(clientId, deadlineKey(clientId, request.id))),
          );
        },
        supportsAck: upstream.supportsAck,
        supportsTransferables: upstream.supportsTransferables,
        codecFor: upstream.codecFor,
      } satisfies RpcClient.Protocol["Service"];
    }),
  );

const contextAssemblerLayer = (homeDir: string) =>
  ContextAssembler.layer({
    homeDir,
    userAgentsDir,
    operatingInstructionsDir: engineOperatingInstructionsDir,
  }).pipe(Layer.provide(contextFsLayer));

const performanceHealthLayer = (options: DaemonOptions) =>
  Layer.succeed(PerformanceHealth.PerformanceHealthSource, {
    snapshot: readPerformanceHealthSnapshot({
      enabled: options.telemetryEnabled,
      storePath: defaultTelemetryStorePath,
    }),
  });

export const serverLayer = (options: DaemonOptions) =>
  Layer.unwrap(
    harnessRunners.pipe(
      Effect.map((runners) =>
        Daemon.serverLayer({
          transport: transportLayer(options.socketPath),
          credentials: credentialsLayer(options.credentialsPath),
          contextAssembler: contextAssemblerLayer(nodePath.dirname(options.controlStorePath)),
          runLedger: ledgerLayer,
          controlStorePath: options.controlStorePath,
          userAgentsDir,
          worktrees: worktreeManagerLayer,
          harnessRunners: runners,
          appVersion: "0.0.1",
          performanceEvidenceRoot: nodePath.join(nodePath.dirname(options.controlStorePath), "perf"),
          performanceHealth: performanceHealthLayer(options),
          performanceIssueWorkspace: options.performanceWorkspace,
        }),
      ),
    ),
  ).pipe(Layer.provide(gitLayer));

export const clientLayer = (socketPath: string) =>
  daemonRpcDeadlineLayer(daemonRpcDeadline).pipe(
    Layer.provide(RpcClient.layerProtocolSocket()),
    Layer.provide(NodeSocket.layerNet({ path: socketPath })),
    Layer.provide(Daemon.serializationLayer),
  );
