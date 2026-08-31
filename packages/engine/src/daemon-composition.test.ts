// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DaemonRpcs, HarnessName } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import * as ContextAssembler from "./context-assembler";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import { fullHarnessExecution, type HarnessRunner } from "./harness";
import { ReconcileWorker } from "./reconcile";
import * as RunLedger from "./run-ledger";
import { WorktreeManager } from "./worktree";

const worktreeLayer = Layer.succeed(WorktreeManager, {
  ensure: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const stubRunner: HarnessRunner = {
  name: Schema.decodeSync(HarnessName)("cursor"),
  sessionKind: "opaque-handle",
  projectedMembers: [],
  planMiddleware: [],
  execution: fullHarnessExecution,
  run: () => Stream.empty,
};

const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () =>
    Effect.succeed({
      layers: [],
      operatingInstructionsPath: "/skills",
      operatingInstructionResources: [],
      sources: [],
    }),
  cleanup: () => Effect.void,
});

const socketServerLayer = (socket: Socket.Socket) =>
  Layer.succeed(SocketServer.SocketServer, {
    address: { _tag: "UnixAddress", path: "memory" },
    run: (handler) => handler(socket).pipe(Effect.ignore, Effect.andThen(Effect.never)),
  });

describe("daemon server composition", () => {
  it.effect("serves RPC without booting dispatch when the Control store is unavailable", () =>
    Effect.gen(function* () {
      const controlStore = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const dir = mkdtempSync(join(tmpdir(), "cogwork-poisoned-store-"));
          const path = join(dir, "control.db");
          const db = new DatabaseSync(path);
          db.exec(
            "CREATE TABLE control_migrations (migration_id INTEGER PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL); INSERT INTO control_migrations (migration_id, name) VALUES (99999999999999, 'from-the-future')",
          );
          db.close();
          return { dir, path };
        }),
        ({ dir }) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const toServer = new TransformStream<Uint8Array, Uint8Array>();
      const toClient = new TransformStream<Uint8Array, Uint8Array>();
      const client = yield* Socket.fromTransformStream(
        Effect.succeed({ readable: toClient.readable, writable: toServer.writable }),
      );
      const server = yield* Socket.fromTransformStream(
        Effect.succeed({ readable: toServer.readable, writable: toClient.writable }),
      );
      const transport = RpcServer.layerProtocolSocketServer.pipe(Layer.provide(socketServerLayer(server)));
      const serverLayer = Daemon.serverLayer({
        transport,
        credentials: CredentialStore.layerEnv,
        contextAssembler: contextAssemblerLayer,
        runLedger: RunLedger.layerMemoryCore,
        controlStorePath: controlStore.path,
        userAgentsDir: join(controlStore.dir, ".agents"),
        worktrees: worktreeLayer,
        harnessRunners: [stubRunner],
      });
      const clientLayer = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.succeed(Socket.Socket, client)),
        Layer.provide(Daemon.serializationLayer),
      );

      const result = yield* Effect.gen(function* () {
        yield* Daemon.bootstrap;
        // Dispatch is not merely idle: `bootstrap` must not submit a reconcile, and `heartbeats`
        // must never begin polling. Both are asserted after time has had a chance to pass.
        const heartbeats = yield* Effect.forkChild(
          Daemon.heartbeats({ pollIntervalMillis: 1000, drain: { graceMillis: 0, abort: Effect.void } }),
        );
        yield* TestClock.adjust("1 minute");
        const worker = yield* ReconcileWorker;
        const reconciled = yield* worker.snapshot;
        const heartbeatsExit = heartbeats.pollUnsafe();
        yield* Fiber.interrupt(heartbeats);
        const rpc = yield* RpcClient.make(DaemonRpcs);
        const runs = yield* rpc.ListRuns();
        const status = yield* rpc.GetStatus();
        return { runs, status, reconciled, heartbeatsExit };
      }).pipe(
        Effect.provide(Layer.mergeAll(serverLayer, clientLayer).pipe(Layer.provide(NodeServices.layer))),
        Effect.scoped,
      );

      assert.deepStrictEqual(result.runs, []);
      assert.strictEqual(result.status.health, "store-unavailable");
      assert.strictEqual(result.reconciled.generation, 0);
      assert.deepStrictEqual(result.reconciled.workspaces, []);
      assert.isUndefined(result.heartbeatsExit);
      assert.strictEqual(result.status.scheduler.globalInFlight, 0);
      assert.deepStrictEqual(result.status.workspaces, []);
    }),
  );
});
