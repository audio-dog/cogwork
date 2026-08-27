import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import type { DaemonRpcBridge } from "../../../shared/ipc";

type Incoming =
  | { readonly _tag: "data"; readonly frame: Uint8Array }
  | { readonly _tag: "closed"; readonly reason: string | null };

const defectError = (message: string, cause: unknown): RpcClientError =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause }) });

export const makeProtocolIpc = (bridge: DaemonRpcBridge) =>
  RpcClient.Protocol.make((writeResponse, clientIds) =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const requestClientMap = new Map<string | number, number>();
      const initialGate = yield* Deferred.make<void, RpcClientError>();
      const conn = {
        parser: serialization.makeUnsafe(),
        gate: initialGate,
      };

      const inbox = yield* Queue.unbounded<Incoming>();
      const offData = bridge.onData((frame) => {
        Queue.offerUnsafe(inbox, { _tag: "data", frame });
      });
      const offClosed = bridge.onClosed((reason) => {
        Queue.offerUnsafe(inbox, { _tag: "closed", reason });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          offData();
          offClosed();
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

      const consume: Effect.Effect<never, RpcClientError> = Queue.take(inbox).pipe(
        Effect.flatMap((message) =>
          message._tag === "closed"
            ? Effect.fail(defectError(message.reason ?? "The daemon connection closed", message.reason))
            : processFrame(message.frame),
        ),
        Effect.forever,
      );

      yield* Effect.gen(function* () {
        conn.parser = serialization.makeUnsafe();
        yield* Effect.tryPromise({
          try: () => bridge.connect(),
          catch: (cause) => defectError("Could not reach the daemon", cause),
        }).pipe(
          Effect.tapError((error) => Deferred.fail(conn.gate, error)),
          Effect.tap(() => Deferred.succeed(conn.gate, undefined)),
        );
        return yield* consume;
      }).pipe(
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
        Effect.retry(Schedule.spaced("1 second")),
        Effect.forkScoped,
      );

      return {
        send: (clientId, request) => {
          if (request._tag === "Request") requestClientMap.set(request.id, clientId);
          const encoded = conn.parser.encode(request);
          if (encoded === undefined) return Effect.void;
          const frame = typeof encoded === "string" ? encoded : new TextDecoder().decode(encoded);
          return Deferred.await(conn.gate).pipe(Effect.andThen(Effect.sync(() => bridge.send(frame))));
        },
        supportsAck: true,
        supportsTransferables: false,
        codecFor: serialization.codecFor,
      };
    }),
  );

export const layerProtocolIpc = (bridge: DaemonRpcBridge): Layer.Layer<RpcClient.Protocol> =>
  Layer.effect(RpcClient.Protocol)(makeProtocolIpc(bridge)).pipe(Layer.provide(RpcSerialization.layerNdjson));
