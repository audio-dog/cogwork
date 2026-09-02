import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { SocketCloseError, SocketOpenError } from "effect/unstable/socket/Socket";
import type { DaemonRpcBridge } from "../../../shared/ipc";
import { recordProtocolInboxChange, resetProtocolInboxDepth } from "./process-health";

type Incoming =
  | { readonly _tag: "data"; readonly frame: Uint8Array }
  | { readonly _tag: "closed"; readonly reason: string | null };

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
      const offData = bridge.onData((frame) => {
        offerIncoming({ _tag: "data", frame });
      });
      const offClosed = bridge.onClosed((reason) => {
        offerIncoming({ _tag: "closed", reason });
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
        if ("requestId" in response) {
          const clientId = requestClientMap.get(response.requestId);
          if (clientId !== undefined) {
            if (response._tag === "Exit") requestClientMap.delete(response.requestId);
            return writeResponse(clientId, response);
          }
        }
        return broadcast(response);
      };

      const processFrame = (frame: Uint8Array) =>
        Effect.try({
          try: () => conn.parser.decode(frame) as ReadonlyArray<FromServerEncoded>,
          catch: (defect) => defectError("Error decoding daemon message", defect),
        }).pipe(
          Effect.flatMap((responses) => Effect.forEach(responses, routeResponse, { discard: true })),
          Effect.catchTag("RpcClientError", (error) => broadcast({ _tag: "ClientProtocolError", error })),
        );

      const consume = (inbox: Queue.Queue<Incoming>) =>
        Queue.take(inbox).pipe(
          Effect.tap(() => Effect.sync(() => recordProtocolInboxChange(-1))),
          Effect.flatMap((message) =>
            message._tag === "closed" ? Effect.fail(closeError(message.reason)) : processFrame(message.frame),
          ),
          Effect.forever,
        );

      yield* Queue.bounded<Incoming>(protocolInboxCapacity).pipe(
        Effect.flatMap((inbox) =>
          Deferred.make<never, RpcClientError>().pipe(
            Effect.flatMap((overflow) =>
              Effect.tryPromise({ try: () => bridge.disconnect(), catch: openError }).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    conn.parser = serialization.makeUnsafe();
                    conn.inbox = inbox;
                    conn.overflow = overflow;
                    resetProtocolInboxDepth();
                  }),
                ),
                Effect.andThen(Effect.tryPromise({ try: () => bridge.connect(), catch: openError })),
                Effect.onExit((exit) => Deferred.done(conn.gate, exit)),
                Effect.andThen(Effect.raceFirst(consume(inbox), Deferred.await(overflow))),
              ),
            ),
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
