import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Ref from "effect/Ref";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ScopedRef from "effect/ScopedRef";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { createDaemonBridgePort, type DaemonBridgePort } from "../../../main/daemon-bridge";
import type { DaemonRpcBridge, RpcSessionId } from "../../../shared/ipc";
import { layerProtocolIpc, makeProtocolIpc, protocolInboxCapacity } from "./protocol";

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

const makeBridge = (socketPath: string): DaemonRpcBridge & { readonly dispose: () => Promise<void> } => {
  const dataListeners = new Set<Parameters<DaemonRpcBridge["onData"]>[0]>();
  const closedListeners = new Set<Parameters<DaemonRpcBridge["onClosed"]>[0]>();
  const runtime = ManagedRuntime.make(Layer.empty);
  const current = runtime.runSync(
    ScopedRef.make<DaemonBridgePort | null>(() => null).pipe(Scope.provide(runtime.scope)),
  );

  const connect = async (sessionId: RpcSessionId) => {
    await runtime.runPromise(
      ScopedRef.set(
        current,
        createDaemonBridgePort(socketPath, {
          onData: (frame) => {
            for (const listener of dataListeners) listener({ sessionId, frame });
          },
          onClosed: (reason) => {
            for (const listener of closedListeners) listener({ sessionId, reason });
          },
        }),
      ),
    );
    const port = await runtime.runPromise(ScopedRef.get(current));
    if (!port) throw new Error("Bridge port was not created");
    await runtime.runPromise(port.connect);
  };

  const send = (frame: string) =>
    runtime.runFork(
      ScopedRef.get(current).pipe(
        Effect.flatMap((port) => port?.send(frame) ?? Effect.void),
        Effect.ignore,
      ),
    );

  return {
    connect,
    disconnect: () => runtime.runPromise(ScopedRef.set(current, Effect.succeed(null))),
    send,
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onClosed: (listener) => {
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    dispose: () => runtime.dispose(),
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
    disconnect: () => Promise.resolve(),
    send: () => undefined,
    onData: () => () => undefined,
    onClosed: () => () => undefined,
  };
  return { bridge, resolve: connection.resolve };
};

const failingBridge = (cause: Error): DaemonRpcBridge => ({
  connect: () => Promise.reject(cause),
  disconnect: () => Promise.resolve(),
  send: () => undefined,
  onData: () => () => undefined,
  onClosed: () => () => undefined,
});

const makeObservedFailingBridge = (cause: Error) => {
  const attempted = Promise.withResolvers<void>();
  return {
    bridge: {
      ...failingBridge(cause),
      connect: () => {
        attempted.resolve();
        return Promise.reject(cause);
      },
    },
    attempted: attempted.promise,
  };
};

class FloodBridgeProbe extends Context.Service<
  FloodBridgeProbe,
  {
    readonly bridge: DaemonRpcBridge;
    readonly flood: (count: number) => Effect.Effect<void>;
    readonly connectionCount: Effect.Effect<number>;
    readonly initialConnectionReady: Effect.Effect<void>;
    readonly reconnectStarted: Effect.Effect<void>;
    readonly reconnectReady: Effect.Effect<void>;
    readonly resumeReconnect: Effect.Effect<void>;
    readonly closeReplacedSession: Effect.Effect<void>;
  }
>()("@cogwork/desktop/test/FloodBridgeProbe") {
  static readonly layer = Layer.effect(
    FloodBridgeProbe,
    Effect.gen(function* () {
      const connections = yield* Ref.make(0);
      const connectedSession = yield* Ref.make<RpcSessionId | null>(null);
      const initialConnectionReady = yield* Deferred.make<void>();
      const initialSession = yield* Deferred.make<RpcSessionId>();
      const reconnectStarted = yield* Deferred.make<void>();
      const reconnectReady = yield* Deferred.make<void>();
      const resumeReconnect = yield* Deferred.make<void>();
      const dataListeners = new Set<Parameters<DaemonRpcBridge["onData"]>[0]>();
      const closedListeners = new Set<Parameters<DaemonRpcBridge["onClosed"]>[0]>();
      return {
        bridge: {
          connect: (sessionId) =>
            Effect.runPromise(
              Ref.updateAndGet(connections, (count) => count + 1).pipe(
                Effect.flatMap((count) => {
                  const waitForReconnect =
                    count === 1
                      ? Effect.void
                      : Deferred.succeed(reconnectStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(resumeReconnect)),
                        );
                  return waitForReconnect.pipe(
                    Effect.andThen(Ref.set(connectedSession, sessionId)),
                    Effect.tap(() => Deferred.succeed(initialSession, sessionId)),
                    Effect.tap(() =>
                      count === 2 ? Deferred.succeed(reconnectReady, undefined) : Effect.void,
                    ),
                  );
                }),
                Effect.tap(() => Deferred.succeed(initialConnectionReady, undefined)),
              ),
            ),
          disconnect: () => Effect.runPromise(Ref.set(connectedSession, null)),
          send: () => undefined,
          onData: (listener) => {
            dataListeners.add(listener);
            return () => dataListeners.delete(listener);
          },
          onClosed: (listener) => {
            closedListeners.add(listener);
            return () => closedListeners.delete(listener);
          },
        },
        flood: (count: number) =>
          Ref.get(connectedSession).pipe(
            Effect.flatMap((sessionId) => {
              if (sessionId === null) return Effect.void;
              return Effect.sync(() => {
                const frame = new TextEncoder().encode("{}\n");
                for (const _ of Array.from({ length: count })) {
                  for (const listener of dataListeners) listener({ sessionId, frame });
                }
              });
            }),
          ),
        connectionCount: Ref.get(connections),
        initialConnectionReady: Deferred.await(initialConnectionReady),
        reconnectStarted: Deferred.await(reconnectStarted),
        reconnectReady: Deferred.await(reconnectReady),
        resumeReconnect: Deferred.succeed(resumeReconnect, undefined).pipe(Effect.asVoid),
        closeReplacedSession: Deferred.await(initialSession).pipe(
          Effect.flatMap((sessionId) =>
            Effect.sync(() => {
              for (const listener of closedListeners) {
                listener({ sessionId, reason: "replaced session closed" });
              }
            }),
          ),
        ),
      };
    }),
  );
}

const serializationThatDefectsOnReset = (defect: Error) => {
  const serialization = RpcSerialization.makeNdjson();
  const parsers = [serialization.makeUnsafe()][Symbol.iterator]();
  return RpcSerialization.RpcSerialization.of({
    ...serialization,
    makeUnsafe: () => {
      const next = parsers.next();
      if (next.done) throw defect;
      return next.value;
    },
  });
};

const pollAfterOneMinute = <A, E>(request: Fiber.Fiber<Exit.Exit<A, E>>) =>
  Effect.gen(function* () {
    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    const completed = request.pollUnsafe();
    return completed !== undefined && Exit.isSuccess(completed) ? completed.value : undefined;
  });

const socketOpenErrorFrom = (exit: Exit.Exit<unknown, unknown> | undefined) => {
  expect(exit).toBeDefined();
  if (exit === undefined || Exit.isSuccess(exit)) throw new Error("expected the send to fail");
  const error = Cause.squash(exit.cause);
  expect(error).toBeInstanceOf(RpcClientError);
  if (!(error instanceof RpcClientError)) throw new Error("expected an RPC client error");
  expect(error.reason._tag).toBe("SocketOpenError");
  if (error.reason._tag !== "SocketOpenError") throw new Error("expected a socket open error");
  return error.reason;
};

const buildProtocol = (bridge: DaemonRpcBridge) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layerProtocolIpc(bridge), scope);
    return { protocol: Context.get(context, RpcClient.Protocol), scope };
  });

const makeLogCapture = () => {
  const messages: Array<string> = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    messages.push(String(message));
  });
  return { logger, messages };
};

describe("IPC RPC protocol", () => {
  it("keeps replaced-session frames out of the replacement inbox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const flood = yield* FloodBridgeProbe;
        yield* Layer.build(layerProtocolIpc(flood.bridge));
        yield* flood.initialConnectionReady;
        yield* flood.flood(protocolInboxCapacity + 1);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        yield* flood.reconnectStarted;
        yield* flood.flood(protocolInboxCapacity + 1);
        yield* flood.resumeReconnect;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow;
        expect(yield* flood.connectionCount).toBe(2);
      }).pipe(Effect.provide(FloodBridgeProbe.layer), Effect.provide(TestClock.layer()), Effect.scoped),
    );
  });

  it("keeps a replaced session close out of the replacement inbox", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const flood = yield* FloodBridgeProbe;
        yield* Layer.build(layerProtocolIpc(flood.bridge));
        yield* flood.initialConnectionReady;
        yield* flood.flood(protocolInboxCapacity + 1);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        yield* flood.reconnectStarted;
        yield* flood.resumeReconnect;
        yield* flood.reconnectReady;
        yield* flood.closeReplacedSession;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow;
        expect(yield* flood.connectionCount).toBe(2);
      }).pipe(Effect.provide(FloodBridgeProbe.layer), Effect.provide(TestClock.layer()), Effect.scoped),
    );
  });

  it("settles the connection gate when connecting fails", async () => {
    const cause = new Error("connection refused");
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        return yield* Effect.exit(client.Ping());
      }).pipe(Effect.provide(layerProtocolIpc(failingBridge(cause))), Effect.scoped),
    );

    const error = socketOpenErrorFrom(exit);
    expect(error.kind).toBe("Unknown");
    expect(error.cause).toBe(cause);
  });

  it("fails a send when the daemon connection never returns", async () => {
    const connection = makeStalledBridge();
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        const request = yield* Effect.forkChild(Effect.exit(client.Ping()));
        const result = yield* pollAfterOneMinute(request);
        connection.resolve();
        return result;
      }).pipe(
        Effect.provide(layerProtocolIpc(connection.bridge)),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    );

    const error = socketOpenErrorFrom(exit);
    expect(error.kind).toBe("Timeout");
  });

  it("settles the connection gate when the connection fiber is interrupted", async () => {
    const connection = makeStalledBridge();
    const capture = makeLogCapture();
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { protocol, scope } = yield* buildProtocol(connection.bridge);
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Effect.yieldNow;
        connection.resolve();
        yield* Fiber.join(closing);
        return yield* RpcClient.make(TestRpcs).pipe(
          Effect.flatMap((client) => client.Ping()),
          Effect.provideService(RpcClient.Protocol, protocol),
          Effect.scoped,
          Effect.exit,
        );
      }).pipe(Effect.withLogger(capture.logger)),
    );

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(capture.messages.some((message) => message.includes("daemon connection fiber crashed"))).toBe(
      false,
    );
  });

  it("settles the connection gate when interrupted during reconnect backoff", async () => {
    const connection = makeObservedFailingBridge(new Error("connection refused"));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const { protocol, scope } = yield* buildProtocol(connection.bridge);
        yield* Effect.promise(() => connection.attempted);
        yield* Effect.yieldNow;
        const request = yield* Effect.forkChild(
          RpcClient.make(TestRpcs).pipe(
            Effect.flatMap((client) => client.Ping()),
            Effect.provideService(RpcClient.Protocol, protocol),
            Effect.scoped,
          ),
        );
        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);
        yield* Effect.yieldNow;
        return request.pollUnsafe();
      }),
    );

    expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });

  it("settles the connection gate and logs when the connection fiber defects", async () => {
    const connection = makeStalledBridge();
    connection.resolve();
    const defect = new Error("parser reset failed");
    const capture = makeLogCapture();
    const protocolLayer = Layer.effect(RpcClient.Protocol)(makeProtocolIpc(connection.bridge)).pipe(
      Layer.provide(
        Layer.succeed(RpcSerialization.RpcSerialization, serializationThatDefectsOnReset(defect)),
      ),
    );

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(TestRpcs);
        const request = yield* Effect.forkChild(Effect.exit(client.Ping()));
        return yield* pollAfterOneMinute(request);
      }).pipe(
        Effect.provide(protocolLayer),
        Effect.provide(TestClock.layer()),
        Effect.withLogger(capture.logger),
        Effect.scoped,
      ),
    );

    expect(exit).toBeDefined();
    if (exit === undefined || Exit.isSuccess(exit)) throw new Error("expected the send to fail");
    expect(Cause.squash(exit.cause)).toBe(defect);
    expect(capture.messages.some((message) => message.includes("daemon connection fiber crashed"))).toBe(
      true,
    );
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
        await bridge.dispose();
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

              // Close before unlinking so the next server can bind the same socket path.
              yield* Scope.close(first, Exit.succeed(undefined));
              yield* Effect.sync(() => rmSync(socketPath, { force: true }));

              const second = yield* Scope.make();
              yield* Layer.buildWithScope(serverLayer(socketPath), second);

              // Retry across teardown because one call can still target the closing socket.
              const pong = yield* client
                .Ping()
                .pipe(Effect.retry(Schedule.spaced("100 millis")), Effect.timeout("10 seconds"));
              expect(pong).toBe("pong");
              yield* Scope.close(second, Exit.succeed(undefined));
            }).pipe(Effect.provide(layerProtocolIpc(bridge)), Effect.scoped),
          );
        } finally {
          await bridge.dispose();
        }
      }),
    20_000,
  );
});
