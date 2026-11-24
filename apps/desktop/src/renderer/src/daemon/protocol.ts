import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schedule from "effect/Schedule";
import { SocketCloseError, SocketOpenError } from "effect/socket/Socket";

import type { DaemonRpcBridge } from "../../../shared/ipc";
import { recordProtocolInboxChange, resetProtocolInboxDepth } from "./process-health";

type Incoming = Data.TaggedEnum<{
  data: { readonly frame: Uint8Array };
  closed: { readonly reason: string | null };
}>;
const Incoming = Data.taggedEnum<Incoming>();

const defectError = (message: string, cause: unknown): RpcClientError =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause }) });

const openError = (cause: unknown) =>
  new RpcClientError({ reason: new SocketOpenError({ kind: "Unknown", cause }) });

const closeError = (reason: string | null) =>
  new RpcClientError({
    reason: new SocketCloseError({ code: 1006, ...(reason === null ? {} : { closeReason: reason }) }),
  });

const timeoutError = (cause: unknown) =>
  new RpcClientError({ reason: new SocketOpenError({ kind: "Timeout", cause }) });

const isReconnectable = (error: RpcClientError) =>
  error.reason._tag === "SocketOpenError" || error.reason._tag === "SocketCloseError";

const connectionGateTimeout = "30 seconds";
export const protocolInboxCapacity = 1_024;
const reconnectSchedule = () =>
  Schedule.exponential("500 millis", 2).pipe(
    Schedule.jittered,
    Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(5)))),
  );

export const makeProtocolIpc = (bridge: DaemonRpcBridge) =>
  RpcClient.Protocol.make((writeResponse, clientIds) =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const requestClientMap = new Map<string | number, number>();
      const initialGate = yield* Deferred.make<void, RpcClientError>();
      const initialInbox = yield* Queue.bounded<Incoming>(protocolInboxCapacity);
      const initialOverflow = yield* Deferred.make<never, RpcClientError>();
      const conn = {
        parser: serialization.makeUnsafe(),
        gate: initialGate,
        inbox: initialInbox,
        overflow: initialOverflow,
        sessionId: 0,
      };

      const offerIncoming = (message: Incoming) => {
        if (!Queue.offerUnsafe(conn.inbox, message)) {
          Deferred.doneUnsafe(
            conn.overflow,
            Effect.fail(closeError(`renderer protocol inbox exceeded ${protocolInboxCapacity} frames`)),
          );
          return;
        }
        recordProtocolInboxChange(1);
      };
      const offData = bridge.onData((message) => {
        if (message.sessionId !== conn.sessionId) return;
        offerIncoming(Incoming.data({ frame: message.frame }));
      });
      const offClosed = bridge.onClosed((message) => {
        if (message.sessionId !== conn.sessionId) return;
        offerIncoming(Incoming.closed({ reason: message.reason }));
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          offData();
          offClosed();
          resetProtocolInboxDepth();
        }),
      );

      const broadcast = (response: FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response), { discard: true });

      const routeResponse = (response: FromServerEncoded) => {
        if (response._tag === "Pong") return Effect.void;
        if (!("requestId" in response)) return broadcast(response);
        const clientId = requestClientMap.get(response.requestId);
        if (clientId === undefined) return broadcast(response);
        if (response._tag === "Exit") requestClientMap.delete(response.requestId);
        return writeResponse(clientId, response);
      };

      const processFrame = (frame: Uint8Array) =>
        Effect.try({
          try: () => conn.parser.decode(frame) as ReadonlyArray<FromServerEncoded>,
          catch: (defect) => defectError("Error decoding daemon message", defect),
        }).pipe(
          Effect.flatMap((responses) => Effect.forEach(responses, routeResponse, { discard: true })),
          Effect.catchTag("RpcClientError", (error) => broadcast({ _tag: "ClientProtocolError", error })),
        );

      const processIncoming = Incoming.$match({
        data: ({ frame }) => processFrame(frame),
        closed: ({ reason }) => Effect.fail(closeError(reason)),
      });

      const consume = (inbox: Queue.Queue<Incoming>) =>
        Queue.take(inbox).pipe(
          Effect.tap(() => Effect.sync(() => recordProtocolInboxChange(-1))),
          Effect.flatMap(processIncoming),
          Effect.forever,
        );

      yield* Queue.bounded<Incoming>(protocolInboxCapacity).pipe(
        Effect.flatMap((inbox) =>
          Deferred.make<never, RpcClientError>().pipe(
            Effect.flatMap((overflow) => {
              const replacedSessionId = conn.sessionId;
              const sessionId = replacedSessionId + 1;
              return Effect.sync(() => {
                conn.parser = serialization.makeUnsafe();
                conn.inbox = inbox;
                conn.overflow = overflow;
                conn.sessionId = sessionId;
                resetProtocolInboxDepth();
              }).pipe(
                Effect.andThen(
                  Effect.tryPromise({
                    try: () => bridge.disconnect(),
                    catch: openError,
                  }),
                ),
                Effect.andThen(Effect.tryPromise({ try: () => bridge.connect(sessionId), catch: openError })),
                Effect.onExit((exit) => Deferred.done(conn.gate, exit)),
                Effect.andThen(Effect.raceFirst(consume(inbox), Deferred.await(overflow))),
              );
            }),
          ),
        ),
        Effect.tapError((error) =>
          broadcast({ _tag: "ClientProtocolError", error }).pipe(
            Effect.andThen(Deferred.make<void, RpcClientError>()),
            Effect.tap((gate) =>
              Effect.sync(() => {
                requestClientMap.clear();
                conn.gate = gate;
              }),
            ),
          ),
        ),
        Effect.retry({
          while: isReconnectable,
          schedule: reconnectSchedule(),
        }),
        Effect.onExit((exit) => Deferred.done(conn.gate, exit)),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.logError("daemon connection fiber crashed", { cause }),
        ),
        Effect.forkScoped,
      );

      return {
        send: (clientId, request) => {
          if (request._tag === "Request") requestClientMap.set(request.id, clientId);
          const encoded = conn.parser.encode(request);
          if (encoded === undefined) return Effect.void;
          const frame = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
          return Deferred.await(conn.gate).pipe(
            Effect.timeout(connectionGateTimeout),
            Effect.catchTag("TimeoutError", (cause) => Effect.fail(timeoutError(cause))),
            Effect.andThen(Effect.sync(() => bridge.send(frame))),
          );
        },
        supportsAck: true,
        supportsTransferables: false,
        codecFor: serialization.codecFor,
      };
    }),
  );

export const layerProtocolIpc = (bridge: DaemonRpcBridge): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(makeProtocolIpc(bridge)).pipe(Layer.provide(RpcSerialization.layerNdjson));
