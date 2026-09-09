import * as os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCodeRunner } from "@cogwork/claude-code";
import { codexRunner } from "@cogwork/codex-cli";
import { DaemonRpcs, HarnessName } from "@cogwork/contracts";
import { cursorRunner } from "@cogwork/cursor-acp";
import { ContextAssembler, Daemon, Provider, Replay } from "@cogwork/engine";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { type FromClientEncoded, type FromServerEncoded, RequestId } from "effect/unstable/rpc/RpcMessage";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { layer as credentialsLayer } from "./credentials";
import { layer as ledgerLayer } from "./ledger";
import { contextFsLayer, gitLayer, worktreeManagerLayer } from "./platform";

export interface DaemonOptions {
  readonly socketPath: string;
  readonly controlStorePath: string;
  readonly credentialsPath: string;
  readonly pollIntervalMillis: number;
  readonly drainGraceMillis: number;
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
const providerName = Schema.decodeSync(HarnessName)("provider");
const replayName = Schema.decodeSync(HarnessName)("replay");

const standardHarnessRunners = [
  cursorRunner({ name: cursorName }),
  claudeCodeRunner({ name: claudeName, authentication: { mode: "host" } }),
  codexRunner({ name: codexName, environment: process.env }),
  Provider.providerRunner({ name: providerName }),
];

export const harnessRunners = Replay.replayRunner({
  name: replayName,
  fixturePath: Config.option(Config.string("COGWORK_REPLAY_FIXTURE")).pipe(Effect.map(Option.getOrUndefined)),
}).pipe(Effect.map((runner) => [...standardHarnessRunners, runner]));

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

interface PendingDeadline {
  readonly clientId: number;
  readonly fiber: Fiber.Fiber<void, never>;
}

const deadlineKey = (clientId: number, requestId: string | number) => `${clientId}:${requestId}`;

const deadlineFailure = (tag: string, deadline: string) => {
  return new DaemonRpcTimeout({ rpc: tag, deadline });
};

const takeDeadlines = (
  deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>,
  predicate: (key: string, pending: PendingDeadline) => boolean,
) =>
  Ref.modify(deadlines, (current) => {
    const matching = [...current].filter(([key, pending]) => predicate(key, pending));
    const remaining = new Map([...current].filter(([key, pending]) => !predicate(key, pending)));
    return [matching.map(([, pending]) => pending), remaining] as const;
  });

const interruptPendingDeadlines = (pending: ReadonlyArray<PendingDeadline>) =>
  Effect.forEach(pending, ({ fiber }) => Fiber.interrupt(fiber), { discard: true });

const cancelDeadline = (
  deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>,
  clientId: number,
  requestId: string | number,
) =>
  takeDeadlines(deadlines, (key) => key === deadlineKey(clientId, requestId)).pipe(
    Effect.flatMap(interruptPendingDeadlines),
  );

const expireDeadline = (
  deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>,
  clientId: number,
  requestId: string | number,
) =>
  takeDeadlines(deadlines, (key) => key === deadlineKey(clientId, requestId)).pipe(
    Effect.map((pending) => pending.length > 0),
  );

const cancelClientDeadlines = (deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>, clientId: number) =>
  takeDeadlines(deadlines, (_key, pending) => pending.clientId === clientId).pipe(
    Effect.flatMap(interruptPendingDeadlines),
  );

const cancelResponseDeadline = (
  deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>,
  clientId: number,
  response: FromServerEncoded,
) => {
  if (response._tag === "Chunk") return cancelDeadline(deadlines, clientId, response.requestId);
  if (response._tag === "Exit") return cancelDeadline(deadlines, clientId, response.requestId);
  if (response._tag === "ClientProtocolError" || response._tag === "Defect") {
    return cancelClientDeadlines(deadlines, clientId);
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

const startDeadline = (
  deadlines: Ref.Ref<ReadonlyMap<string, PendingDeadline>>,
  handlers: Ref.Ref<ReadonlyMap<number, (response: FromServerEncoded) => Effect.Effect<void>>>,
  upstream: RpcClient.Protocol["Service"],
  encodeError: (error: DaemonRpcTimeout) => Effect.Effect<unknown, Schema.SchemaError>,
  deadline: Duration.Input,
  clientId: number,
  request: Extract<FromClientEncoded, { readonly _tag: "Request" }>,
) => {
  const key = deadlineKey(clientId, request.id);
  return Effect.sleep(deadline).pipe(
    Effect.andThen(expireDeadline(deadlines, clientId, request.id)),
    Effect.flatMap((claimed) => {
      if (!claimed) return Effect.void;
      return encodeError(deadlineFailure(request.tag, String(deadline))).pipe(
        Effect.orDie,
        Effect.flatMap((encodedError) => notifyDeadline(handlers, clientId, request.id, encodedError)),
        Effect.andThen(
          sendInterrupt(upstream, clientId, request.id).pipe(
            Effect.timeout("1 second"),
            Effect.ignoreCause,
            Effect.forkDetach,
            Effect.asVoid,
          ),
        ),
      );
    }),
    Effect.forkDetach,
    Effect.flatMap((fiber) =>
      Ref.update(deadlines, (current) => new Map(current).set(key, { clientId, fiber })),
    ),
  );
};

export const daemonRpcDeadlineLayer = (
  deadline: Duration.Input,
): Layer.Layer<RpcClient.Protocol, never, RpcClient.Protocol> =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const upstream = yield* RpcClient.Protocol;
      const encodeError = Schema.encodeUnknownEffect(upstream.codecFor(DaemonRpcTimeout));
      const deadlines = yield* Ref.make<ReadonlyMap<string, PendingDeadline>>(new Map());
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
              cancelClientDeadlines(deadlines, clientId).pipe(
                Effect.andThen(
                  Ref.update(
                    handlers,
                    (current) =>
                      new Map([...current].filter(([currentClientId]) => currentClientId !== clientId)),
                  ),
                ),
              ),
            ),
          ),
        send: (clientId, request, transferables) => {
          if (request._tag === "Interrupt") {
            return cancelDeadline(deadlines, clientId, request.requestId).pipe(
              Effect.andThen(upstream.send(clientId, request, transferables)),
            );
          }
          if (request._tag !== "Request") {
            return upstream.send(clientId, request, transferables);
          }
          return startDeadline(deadlines, handlers, upstream, encodeError, deadline, clientId, request).pipe(
            Effect.andThen(upstream.send(clientId, request, transferables)),
            Effect.onError(() => cancelDeadline(deadlines, clientId, request.id)),
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
