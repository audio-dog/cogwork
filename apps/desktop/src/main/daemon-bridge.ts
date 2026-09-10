import { NodeSocket } from "@effect/platform-node";
import { Deferred, Effect, Scope } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { type DaemonReachabilityError, waitForDaemonListening } from "./wait-for-socket";

export interface DaemonBridgeSink {
  readonly onData: (frame: Uint8Array) => void;
  readonly onClosed: (reason: string | null) => void;
}

type BridgeFailure = DaemonReachabilityError | Socket.SocketError;

export interface DaemonBridgePort {
  readonly connect: Effect.Effect<void, BridgeFailure>;
  readonly send: (frame: string) => Effect.Effect<void, Socket.SocketError>;
}

const connectTimeout = "10 seconds";

const closedReason = (error: BridgeFailure) => {
  if (!Socket.SocketError.is(error)) return error.message;
  if (error.reason._tag !== "SocketCloseError") return error.message;
  if (error.reason.code === 1000) return null;
  return error.reason.closeReason ?? error.message;
};

export const createDaemonBridgePort = Effect.fn("DaemonBridge.createPort")(function* (
  socketPath: string,
  sink: DaemonBridgeSink,
) {
  const scope = yield* Effect.scope;
  const socket = yield* NodeSocket.makeNet({ path: socketPath, openTimeout: connectTimeout });
  const write = yield* socket.writer;
  const connected = yield* Deferred.make<void, BridgeFailure>();
  yield* Scope.addFinalizer(scope, Deferred.interrupt(connected));
  yield* Effect.forkIn(
    waitForDaemonListening(socketPath).pipe(
      Effect.andThen(
        socket.run((frame) => sink.onData(frame), {
          onOpen: Deferred.succeed(connected, undefined),
        }),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          Deferred.isDone(connected).pipe(
            Effect.flatMap((wasConnected) =>
              wasConnected
                ? Effect.sync(() => sink.onClosed(closedReason(error)))
                : Deferred.fail(connected, error),
            ),
            Effect.asVoid,
          ),
        onSuccess: () => Effect.sync(() => sink.onClosed(null)),
      }),
    ),
    scope,
  );

  return {
    connect: Deferred.await(connected),
    send: write,
  } satisfies DaemonBridgePort;
});
