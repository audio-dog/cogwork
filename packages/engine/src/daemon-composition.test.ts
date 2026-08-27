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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import * as ContextAssembler from "./context-assembler";
import * as CredentialStore from "./credential-store";
import * as Daemon from "./daemon";
import type { HarnessRunner } from "./harness";
import * as Registry from "./registry";
import * as RunLedger from "./run-ledger";
import { WorktreeManager } from "./worktree";

const workspace: Registry.LoadedWorkspace = {
  source: "example.workspace.ts",
  value: {
    name: "example",
    checkoutPath: "/repos/example",
    issueTracker: { type: "linear" },
    harness: { preferred: "cursor" },
  },
};

const registryLayer = Layer.succeed(
  Registry.WorkspaceRegistry,
  Registry.buildRegistry({ loaded: [workspace], failures: [] }),
);

const worktreeLayer = Layer.succeed(WorktreeManager, {
  ensure: () => Effect.die("unused"),
  list: () => Effect.succeed([]),
  remove: () => Effect.void,
  reconcile: () => Effect.succeed({ tornDown: [], reaped: [] }),
});

const stubRunner: HarnessRunner = {
  name: Schema.decodeSync(HarnessName)("cursor"),
  sessionKind: "opaque-handle",
  run: () => Stream.empty,
};

const contextAssemblerLayer = Layer.succeed(ContextAssembler.ContextAssembler, {
  assemble: () => Effect.succeed({ layers: [], skillPath: "/skills" }),
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
          // A history that claims a migration this build does not ship — the store was written by
          // a newer daemon, so booting it would apply nothing and leave the schema wrong.
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
        registry: registryLayer,
        worktrees: worktreeLayer,
        harnessRunners: [stubRunner],
        scheduler: { globalLimit: 4, perWorkspaceLimit: 4, dailyBudget: 50 },
      });
      const clientLayer = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.succeed(Socket.Socket, client)),
        Layer.provide(Daemon.serializationLayer),
      );

      const result = yield* Effect.gen(function* () {
        yield* Daemon.bootstrap;
        const rpc = yield* RpcClient.make(DaemonRpcs);
        const runs = yield* rpc.ListRuns();
        const status = yield* rpc.GetStatus();
        return { runs, status };
      }).pipe(
        Effect.provide(Layer.mergeAll(serverLayer, clientLayer).pipe(Layer.provide(NodeServices.layer))),
        Effect.scoped,
      );

      assert.deepStrictEqual(result.runs, []);
      assert.strictEqual(result.status.health, "store-unavailable");
      assert.deepStrictEqual(
        result.status.workspaces.map((w) => w.name),
        ["example"],
      );
    }),
  );
});
