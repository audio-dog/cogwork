import { NodeSocket } from "@effect/platform-node";
import { Deferred, Effect, Scope } from "effect";
import * as Socket from "effect/socket/Socket";

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
  const writer = yield* socket.writer;
  const connected = yield* Deferred.make<void, BridgeFailure>();
  yield* Scope.addFinalizer(scope, Deferred.interrupt(connected));
  yield* Effect.forkIn(
    waitForDaemonListening(socketPath).pipe(
      Effect.andThen(
        Effect.scoped(
          Socket.readerBytes(socket).pipe(
            Effect.tap(() => Deferred.succeed(connected, undefined)),
            Effect.flatMap((pull) =>
              pull.pipe(
                Effect.flatMap((frames) => Effect.sync(() => frames.forEach(sink.onData))),
                Effect.forever,
              ),
            ),
          ),
        ),
      ),
      Effect.catch((error: BridgeFailure) =>
        Deferred.isDone(connected).pipe(
          Effect.flatMap((wasConnected) =>
            wasConnected
              ? Effect.sync(() => sink.onClosed(closedReason(error)))
              : Deferred.fail(connected, error),
          ),
          Effect.asVoid,
        ),
      ),
    ),
    scope,
  );

  return {
    connect: Deferred.await(connected),
    send: (frame: string) => writer.write(frame),
  } satisfies DaemonBridgePort;
});
