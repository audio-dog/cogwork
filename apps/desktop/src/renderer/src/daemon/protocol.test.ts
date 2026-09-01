import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { describe, expect, it } from "vitest";
import { createDaemonBridgePort } from "../../../main/daemon-bridge";
import type { DaemonRpcBridge } from "../../../shared/ipc";
import { layerProtocolIpc, makeProtocolIpc } from "./protocol";

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

const makeStalledBridge = () => {
  const connection = Promise.withResolvers<void>();
  const bridge: DaemonRpcBridge = {
    connect: () => connection.promise,
    send: () => undefined,
    onData: () => () => undefined,
    onClosed: () => () => undefined,
  };
  return { bridge, resolve: connection.resolve };
};

const failingBridge = (cause: Error): DaemonRpcBridge => ({
  connect: () => Promise.reject(cause),
  send: () => undefined,
  onData: () => () => undefined,
  onClosed: () => () => undefined,
});

const serializationThatDefectsOnReset = (defect: Error) => {
  const serialization = RpcSerialization.makeNdjson();
  const parsers = [serialization.makeUnsafe(), defect][Symbol.iterator]();
  return RpcSerialization.RpcSerialization.of({
    ...serialization,
    makeUnsafe: () => {
      const next = parsers.next();
      if (next.done || next.value instanceof Error) throw defect;
      return next.value;
    },
  });
};

describe("IPC RPC protocol", () => {
  it("settles the connection gate when connecting fails", async () => {
    const cause = new Error("connection refused");
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        return yield* Effect.exit(client.Ping());
      }).pipe(Effect.provide(layerProtocolIpc(failingBridge(cause))), Effect.scoped),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("expected the send to fail");
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(RpcClientError);
    if (!(error instanceof RpcClientError)) throw new Error("expected an RPC client error");
    expect(error.reason._tag).toBe("SocketOpenError");
    if (error.reason._tag !== "SocketOpenError") throw new Error("expected a socket open error");
    expect(error.reason.kind).toBe("Unknown");
    expect(error.reason.cause).toBe(cause);
  });

  it("fails a send when the daemon connection never returns", async () => {
    const connection = makeStalledBridge();
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        const request = yield* Effect.forkChild(Effect.exit(client.Ping()));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        const completed = request.pollUnsafe();
        const result = completed !== undefined && Exit.isSuccess(completed) ? completed.value : undefined;
        connection.resolve();
        return result;
      }).pipe(
        Effect.provide(layerProtocolIpc(connection.bridge)),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    );

    expect(exit).toBeDefined();
    if (exit === undefined || Exit.isSuccess(exit)) throw new Error("expected the send to fail");
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(RpcClientError);
    if (!(error instanceof RpcClientError)) throw new Error("expected an RPC client error");
    expect(error.reason._tag).toBe("SocketOpenError");
    if (error.reason._tag !== "SocketOpenError") throw new Error("expected a socket open error");
    expect(error.reason.kind).toBe("Timeout");
  });

  it("settles the connection gate when the connection fiber is interrupted", async () => {
    const connection = makeStalledBridge();
    const messages: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(String(message));
    });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const protocolScope = yield* Scope.make();
        const protocolContext = yield* Layer.buildWithScope(
          layerProtocolIpc(connection.bridge),
          protocolScope,
        );
        const protocol = Context.get(protocolContext, RpcClient.Protocol);
        const closing = yield* Effect.forkChild(Scope.close(protocolScope, Exit.void));
        yield* Effect.yieldNow;
        connection.resolve();
        yield* Fiber.join(closing);
        return yield* Effect.gen(function* () {
          const client = yield* RpcClient.make(TestRpcs);
          return yield* client.Ping();
        }).pipe(Effect.provideService(RpcClient.Protocol, protocol), Effect.scoped, Effect.exit);
      }).pipe(Effect.withLogger(logger)),
    );

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(messages.some((message) => message.includes("daemon connection fiber crashed"))).toBe(false);
  });

  it("settles the connection gate and logs when the connection fiber defects", async () => {
    const connection = makeStalledBridge();
    connection.resolve();
    const defect = new Error("parser reset failed");
    const messages: Array<string> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(String(message));
    });
    const protocolLayer = Layer.effect(RpcClient.Protocol)(makeProtocolIpc(connection.bridge)).pipe(
      Layer.provide(
        Layer.succeed(RpcSerialization.RpcSerialization, serializationThatDefectsOnReset(defect)),
      ),
    );

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        const request = yield* Effect.forkChild(Effect.exit(client.Ping()));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        const completed = request.pollUnsafe();
        return completed !== undefined && Exit.isSuccess(completed) ? completed.value : undefined;
      }).pipe(
        Effect.provide(protocolLayer),
        Effect.provide(TestClock.layer()),
        Effect.withLogger(logger),
        Effect.scoped,
      ),
    );

    expect(exit).toBeDefined();
    if (exit === undefined || Exit.isSuccess(exit)) throw new Error("expected the send to fail");
    expect(Cause.squash(exit.cause)).toBe(defect);
    expect(messages.some((message) => message.includes("daemon connection fiber crashed"))).toBe(true);
  });

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

              yield* Scope.close(first, Exit.succeed(undefined));
              yield* Effect.sync(() => rmSync(socketPath, { force: true }));

              const second = yield* Scope.make();
              yield* Layer.buildWithScope(serverLayer(socketPath), second);

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
