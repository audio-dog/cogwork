import { readControlStore } from "@cogwork/engine";
import * as Flag from "effect/cli/Flag";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import { SocketErrorReason, SocketOpenError } from "effect/socket/Socket";

import { defaultControlStorePath, defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

export const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

export const controlStoreFlag = Flag.String("control-store").pipe(
  Flag.withDescription("Path to the machine-local Control store"),
  Flag.withDefault(defaultControlStorePath),
);

const isUnavailableDaemonError = (error: unknown) =>
  Schema.is(SocketOpenError)(error) ||
  (Schema.is(RpcClientError)(error) && Schema.is(SocketOpenError)(error.reason));

const isDaemonTransportError = (error: unknown) =>
  Schema.is(SocketErrorReason)(error) ||
  (Schema.is(RpcClientError)(error) && Schema.is(SocketErrorReason)(error.reason));

export const daemonOrStore = <A, E, R, E2, R2>(
  daemon: Effect.Effect<A, E | RpcClientError, R>,
  store: Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E | E2 | RpcClientError, R | R2> =>
  Effect.catchIf(daemon, isUnavailableDaemonError, () => store);

export const reportDaemonTransportError = (socketPath: string, error: unknown) =>
  isDaemonTransportError(error)
    ? Console.error(`Could not reach cogwork daemon at ${socketPath}: ${String(error)}`)
    : Effect.void;

export const overSocket = <E, R>(effect: Effect.Effect<void, E, R>, socketPath: string) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(clientLayer(socketPath)),
    Effect.tapError((error) => reportDaemonTransportError(socketPath, error)),
  );

export interface ControlStoreReadOptions {
  readonly socketPath: string;
  readonly controlStorePath: string;
}

export const currentControlStore = (options: ControlStoreReadOptions) =>
  daemonOrStore(
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      return yield* client.GetControlStore();
    }).pipe(Effect.scoped, Effect.provide(clientLayer(options.socketPath))),
    readControlStore(options.controlStorePath),
  );
