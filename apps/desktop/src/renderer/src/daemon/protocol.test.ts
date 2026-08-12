import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { describe, expect, it } from "vitest";
import { createDaemonBridgePort } from "../../../main/daemon-bridge";
import type { DaemonRpcBridge } from "../../../shared/ipc";
import { layerProtocolIpc } from "./protocol";

const Ping = Rpc.make("Ping", { success: Schema.String });
const Counter = Rpc.make("Counter", { success: Schema.Int, stream: true });
const TestRpcs = RpcGroup.make(Ping, Counter);

const handlers = TestRpcs.toLayer({
  Ping: () => Effect.succeed("pong"),
  Counter: () => Stream.fromIterable([1, 2, 3]),
});

const serverLayer = (socketPath: string) =>
  RpcServer.layer(TestRpcs).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(NodeSocketServer.layer({ path: socketPath })),
    Layer.provide(RpcSerialization.layerNdjson),
  );

const makeBridge = (socketPath: string): DaemonRpcBridge & { readonly dispose: () => void } => {
  const dataListeners = new Set<(frame: Uint8Array) => void>();
  const closedListeners = new Set<(reason: string | null) => void>();
  const port = createDaemonBridgePort(socketPath, {
    onData: (frame) => {
      for (const listener of dataListeners) listener(frame);
    },
    onClosed: (reason) => {
      for (const listener of closedListeners) listener(reason);
    },
  });
  return {
    connect: () => port.connect(),
    send: (frame) => port.send(frame),
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    dispose: port.dispose,
  };
};

const withTempSocket = async (run: (socketPath: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-rpc-"));
  try {
    await run(join(dir, "daemon.sock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("IPC RPC protocol", () => {
  it("carries a query and a stream over the relay to a real RPC server", () =>
    withTempSocket(async (socketPath) => {
      const bridge = makeBridge(socketPath);

      try {
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* RpcClient.make(TestRpcs);
            const pong = yield* client.Ping();
            const counts = yield* client.Counter().pipe(Stream.take(3), Stream.runCollect);
            return { pong, counts: Array.from(counts) };
          }).pipe(
            Effect.provide(layerProtocolIpc(bridge)),
            Effect.provide(serverLayer(socketPath)),
            Effect.scoped,
          ),
        );
        expect(result.pong).toBe("pong");
        expect(result.counts).toEqual([1, 2, 3]);
      } finally {
        bridge.dispose();
      }
    }));

  it(
    "recovers after the daemon socket drops and the daemon restarts",
    () =>
      withTempSocket(async (socketPath) => {
        const bridge = makeBridge(socketPath);

        try {
          await Effect.runPromise(
            Effect.gen(function* () {
              const client = yield* RpcClient.make(TestRpcs);

              const first = yield* Scope.make();
              yield* Layer.buildWithScope(serverLayer(socketPath), first);
              expect(yield* client.Ping()).toBe("pong");

              // Remove the socket file after closing so a fresh server can bind the same path.
              yield* Scope.close(first, Exit.succeed(undefined));
              yield* Effect.sync(() => rmSync(socketPath, { force: true }));

              const second = yield* Scope.make();
              yield* Layer.buildWithScope(serverLayer(socketPath), second);

              // Retry across the reconnect window: a call can fail once while the old socket tears down.
              const pong = yield* client
                .Ping()
                .pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("10 seconds"));
              expect(pong).toBe("pong");
              yield* Scope.close(second, Exit.succeed(undefined));
            }).pipe(Effect.provide(layerProtocolIpc(bridge)), Effect.scoped),
          );
        } finally {
          bridge.dispose();
        }
      }),
    20_000,
  );
});
