import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { defaultSocketPath } from "./paths";
import {
  DaemonRpcTimeout,
  daemonRpcDeadline,
  daemonRpcDeadlineLayer,
  makeDaemonClient,
  transportLayer,
} from "./rpc";

const interruptionGate = Latch.makeUnsafe();

const assertDeadlineError = (error: unknown, tag: string) => {
  assert.isTrue(Schema.is(DaemonRpcTimeout)(error));
  if (!Schema.is(DaemonRpcTimeout)(error)) return;
  assert.strictEqual(error.rpc, tag);
  assert.strictEqual(error.deadline, "5 minutes");
  assert.include(error.message, `${tag} did not answer within 5 minutes`);
};

const assertTimedOutMessages = (messages: ReadonlyArray<FromClientEncoded>) => {
  assert.deepStrictEqual(
    messages.map((message) => message._tag),
    ["Request", "Interrupt"],
  );
  assert.strictEqual(messages[0]?._tag, "Request");
  assert.strictEqual(messages[1]?._tag, "Interrupt");
  if (messages[0]?._tag !== "Request" || messages[1]?._tag !== "Interrupt") return;
  assert.strictEqual(messages[1].requestId, messages[0].id);
};

class ResponseGate extends Context.Service<ResponseGate, Latch.Latch>()(
  "@cogwork/cli/rpc.test/ResponseGate",
) {
  static readonly layer = Layer.effect(ResponseGate, Latch.make());
}

class DeadlineDefectLog extends Context.Service<DeadlineDefectLog, Deferred.Deferred<void>>()(
  "@cogwork/cli/rpc.test/DeadlineDefectLog",
) {
  static readonly layer = Layer.effect(DeadlineDefectLog, Deferred.make<void>());
  static readonly captureLayer = Logger.layer([
    Effect.map(DeadlineDefectLog, (logged) =>
      Logger.make(({ message }) => {
        if (!String(message).includes("RPC deadline fiber failed")) return;
        Deferred.doneUnsafe(logged, Effect.void);
      }),
    ),
  ]).pipe(Layer.provideMerge(DeadlineDefectLog.layer));
}

class SentMessages extends Context.Service<SentMessages, Ref.Ref<ReadonlyArray<FromClientEncoded>>>()(
  "@cogwork/cli/rpc.test/SentMessages",
) {
  static readonly layer = Layer.effect(SentMessages, Ref.make<ReadonlyArray<FromClientEncoded>>([]));

  static readonly clientLayer = daemonRpcDeadlineLayer(daemonRpcDeadline).pipe(
    Layer.provide(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.Protocol.make(() =>
          Effect.gen(function* () {
            const messages = yield* SentMessages;
            const serialization = yield* RpcSerialization.RpcSerialization;
            return {
              send: (_clientId, message) =>
                Ref.update(messages, (current) => [...current, message]).pipe(
                  Effect.andThen(message._tag === "Request" ? interruptionGate.await : Effect.void),
                ),
              supportsAck: true,
              supportsTransferables: false,
              codecFor: serialization.codecFor,
            };
          }),
        ),
      ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
    Layer.provideMerge(SentMessages.layer),
  );

  static readonly respondingClientLayer = daemonRpcDeadlineLayer("1 second").pipe(
    Layer.provide(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.Protocol.make((writeResponse) =>
          Effect.gen(function* () {
            const messages = yield* SentMessages;
            const responseGate = yield* ResponseGate;
            const serialization = yield* RpcSerialization.RpcSerialization;
            return {
              send: (clientId, message) =>
                Ref.update(messages, (current) => [...current, message]).pipe(
                  Effect.andThen(
                    message._tag === "Request"
                      ? responseGate.await.pipe(
                          Effect.andThen(
                            writeResponse(clientId, {
                              _tag: "Exit",
                              requestId: message.id,
                              exit: { _tag: "Success", value: [] },
                            }),
                          ),
                        )
                      : Effect.void,
                  ),
                ),
              supportsAck: true,
              supportsTransferables: false,
              codecFor: serialization.codecFor,
            };
          }),
        ),
      ).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
    Layer.provideMerge(Layer.merge(SentMessages.layer, ResponseGate.layer)),
  );
}

const makeSocketFixture = Effect.fn("test.makeSocketFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "cf-" });
  const dir = path.join(home, "home");
  return { dir, socketPath: path.join(dir, "d.sock") };
});

class SocketFixture extends Context.Service<
  SocketFixture,
  { readonly dir: string; readonly socketPath: string }
>()("@cogwork/cli/rpc.test/SocketFixture") {
  static readonly layer = Layer.effect(SocketFixture, makeSocketFixture());
  static readonly looseDirectoryLayer = Layer.effect(
    SocketFixture,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fixture = yield* makeSocketFixture();
      yield* fs.makeDirectory(fixture.dir, { mode: 0o755 });
      return fixture;
    }),
  );
}

const socketTestLayer = <E, R>(fixtureLayer: Layer.Layer<SocketFixture, E, R>) =>
  Layer.unwrap(
    Effect.map(SocketFixture, ({ socketPath }) =>
      transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson)),
    ),
  ).pipe(Layer.provideMerge(fixtureLayer), Layer.provideMerge(NodeServices.layer));

const withTransport = <A, E, R>(socketPath: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson))),
    Effect.scoped,
  );

describe("daemon socket", () => {
  layer(SentMessages.clientLayer)((it) => {
    it.effect("fails a daemon call that does not answer before the deadline", () =>
      Effect.gen(function* () {
        const client = yield* makeDaemonClient();
        const messages = yield* SentMessages;
        const fiber = yield* Effect.flip(client.ListRuns()).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust(daemonRpcDeadline);

        assertDeadlineError(yield* Fiber.join(fiber), "ListRuns");
        yield* Effect.yieldNow;
        assertTimedOutMessages(yield* Ref.get(messages));
      }).pipe(Effect.scoped),
    );
  });

  it.effect("cancels only the disconnected client's deadlines", () =>
    Effect.gen(function* () {
      const ownerScope = yield* Effect.scope;
      const firstClientScope = yield* Scope.fork(ownerScope);
      const secondClientScope = yield* Scope.fork(ownerScope);
      const firstClient = yield* makeDaemonClient().pipe(
        Effect.provideService(Scope.Scope, firstClientScope),
      );
      const secondClient = yield* makeDaemonClient().pipe(
        Effect.provideService(Scope.Scope, secondClientScope),
      );
      const messages = yield* SentMessages;
      const first = yield* Effect.forkChild(firstClient.ListRuns(), { startImmediately: true });
      const second = yield* Effect.forkChild(secondClient.GetStatus(), { startImmediately: true });

      yield* Effect.yieldNow;
      const requestIds = (yield* Ref.get(messages)).flatMap((message) =>
        message._tag === "Request" ? [message.id] : [],
      );
      assert.lengthOf(requestIds, 2);

      yield* Scope.close(firstClientScope, Exit.void);
      const messagesAfterDisconnect = yield* Ref.get(messages);
      yield* TestClock.adjust(daemonRpcDeadline);
      const deadlineMessages = (yield* Ref.get(messages)).slice(messagesAfterDisconnect.length);

      assert.deepStrictEqual(
        deadlineMessages.map((message) => message._tag),
        ["Interrupt"],
      );
      assert.strictEqual(deadlineMessages[0]?._tag, "Interrupt");
      if (deadlineMessages[0]?._tag !== "Interrupt") return;
      assert.strictEqual(deadlineMessages[0].requestId, requestIds[1]);

      yield* Scope.close(secondClientScope, Exit.void);
      yield* Fiber.interruptAll([first, second]);
    }).pipe(Effect.provide(SentMessages.clientLayer), Effect.scoped),
  );

  it.effect("logs a deadline fiber defect", () =>
    Effect.gen(function* () {
      const logged = yield* DeadlineDefectLog;
      const messages = yield* SentMessages;
      const protocol = yield* RpcClient.Protocol;
      const runFiber = yield* protocol
        .run(100, () => Effect.die("deadline handler defect"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      const sendFiber = yield* protocol
        .send(100, {
          _tag: "Request",
          id: "defect-request",
          tag: "ListRuns",
          payload: {},
          headers: [],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* TestClock.adjust(daemonRpcDeadline);
      yield* Deferred.await(logged);

      assert.deepStrictEqual(
        (yield* Ref.get(messages)).map((message) => message._tag),
        ["Request", "Interrupt"],
      );
      yield* Fiber.interruptAll([runFiber, sendFiber]);
    }).pipe(
      Effect.provide(Layer.merge(SentMessages.clientLayer, DeadlineDefectLog.captureLayer)),
      Effect.scoped,
    ),
  );

  layer(SentMessages.respondingClientLayer)((it) => {
    it.effect("does not time out after a response wins the deadline race", () =>
      Effect.gen(function* () {
        const client = yield* makeDaemonClient();
        const messages = yield* SentMessages;
        const responseGate = yield* ResponseGate;
        const fiber = yield* client
          .ListRuns()
          .pipe(
            Effect.provideService(Scheduler.MaxOpsBeforeYield, 4),
            Effect.forkChild({ startImmediately: true }),
          );

        yield* Effect.yieldNow;
        yield* responseGate.open;
        yield* TestClock.adjust("1 second");

        assert.deepStrictEqual(yield* Fiber.join(fiber), []);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(
          (yield* Ref.get(messages)).map((message) => message._tag),
          ["Request"],
        );
      }).pipe(Effect.scoped),
    );
  });

  layer(SentMessages.clientLayer)((it) => {
    it.effect("fails a watch stream that never sends its first event before the deadline", () =>
      Effect.gen(function* () {
        const client = yield* makeDaemonClient();
        const messages = yield* SentMessages;
        const fiber = yield* Effect.flip(client.WatchEvents().pipe(Stream.runHead)).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust(daemonRpcDeadline);

        assertDeadlineError(yield* Fiber.join(fiber), "WatchEvents");
        yield* Effect.yieldNow;
        assertTimedOutMessages(yield* Ref.get(messages));
      }).pipe(Effect.scoped),
    );
  });

  layer(SentMessages.clientLayer)((it) => {
    it.effect("keeps each concurrent daemon call on its own deadline", () =>
      Effect.gen(function* () {
        const client = yield* makeDaemonClient();
        const first = yield* Effect.flip(client.ListRuns()).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust("4 minutes");

        const second = yield* Effect.flip(client.GetStatus()).pipe(
          Effect.forkChild({ startImmediately: true }),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 minute");

        assertDeadlineError(yield* Fiber.join(first), "ListRuns");
        assert.isUndefined(second.pollUnsafe());

        yield* TestClock.adjust("4 minutes");

        assertDeadlineError(yield* Fiber.join(second), "GetStatus");
      }).pipe(Effect.scoped),
    );
  });

  it.effect("lives under the ~/.cogwork home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.strictEqual(path.basename(path.dirname(defaultSocketPath)), ".cogwork");
      assert.strictEqual(path.basename(defaultSocketPath), "cogwork.sock");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("binds a 0600 socket inside a freshly created 0700 directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, socketPath } = yield* SocketFixture;

      assert.strictEqual((yield* fs.stat(socketPath)).mode & 0o777, 0o600);
      assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700);
    }).pipe(Effect.provide(socketTestLayer(SocketFixture.layer))),
  );

  it.effect("tightens a pre-existing loose socket directory to 0700", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir } = yield* SocketFixture;

      assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700);
    }).pipe(Effect.provide(socketTestLayer(SocketFixture.looseDirectoryLayer))),
  );

  it.effect("releases the socket on scope teardown, leaving nothing to leak", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { socketPath } = yield* SocketFixture;

      yield* withTransport(
        socketPath,
        Effect.map(fs.exists(socketPath), (exists) => assert.isTrue(exists)),
      );

      assert.isFalse(yield* fs.exists(socketPath));

      yield* withTransport(socketPath, Effect.void);
    }).pipe(Effect.provide(SocketFixture.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
