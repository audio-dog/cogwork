import { bootControlStoreLayer, DaemonEventBus, RunLedger } from "@cogwork/engine";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, layer } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as GenericSqlClient from "effect/sql/SqlClient";

import { layer as ledgerLayer } from "./ledger";
import { record, runId } from "./ledger-fixtures";

describe("published sqlite RunLedger mutations", () => {
  class BaseSqliteClient extends Context.Service<
    BaseSqliteClient,
    typeof SqliteClient.SqliteClient.Service
  >()("@cogwork/cli/ledger-published-mutations.test/BaseSqliteClient") {}

  class StatementLog extends Context.Service<StatementLog, Ref.Ref<ReadonlyArray<string>>>()(
    "@cogwork/cli/ledger-published-mutations.test/StatementLog",
  ) {
    static readonly layer = Layer.effect(StatementLog, Ref.make<ReadonlyArray<string>>([]));
  }

  const countingClientLayer = (storePath: string) =>
    Layer.effectContext(
      Effect.gen(function* () {
        const client = yield* BaseSqliteClient;
        const statements = yield* StatementLog;
        const countedClient = new Proxy(client, {
          get(target, property, receiver) {
            if (property !== "unsafe") return Reflect.get(target, property, receiver);
            return (query: string, params?: ReadonlyArray<unknown>) => {
              MutableRef.update(statements.ref, (entries) => [...entries, query]);
              return target.unsafe(query, params);
            };
          },
        });
        return Context.make(SqliteClient.SqliteClient, countedClient).pipe(
          Context.add(GenericSqlClient.SqlClient, countedClient),
        );
      }),
    ).pipe(
      Layer.provide(
        Layer.effect(BaseSqliteClient, SqliteClient.SqliteClient).pipe(
          Layer.provide(SqliteClient.layer({ filename: storePath, busyTimeout: "25 millis" })),
        ),
      ),
      Layer.provideMerge(StatementLog.layer),
    );

  layer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-ledger-statements-" });
      const storePath = path.join(dir, "control.db");
      return RunLedger.publishingLayer.pipe(
        Layer.provideMerge(
          Layer.merge(ledgerLayer, bootControlStoreLayer(storePath)).pipe(
            Layer.provideMerge(countingClientLayer(storePath)),
          ),
        ),
        Layer.provide(DaemonEventBus.layer),
      );
    }).pipe(Layer.unwrap, Layer.provide(NodeServices.layer)),
  )((it) => {
    it.effect("publishes with two statements and never selects event payloads", () =>
      Effect.gen(function* () {
        const ledger = yield* RunLedger.RunLedger;
        const statements = yield* StatementLog;
        const id = runId("statement-count");
        yield* ledger.insertRun(record(id, 1000));
        yield* Effect.forEach(
          Array.from({ length: 100 }, (_, seq) => seq),
          (seq) =>
            ledger.appendEvent(id, {
              seq,
              type: "TEXT_MESSAGE_CONTENT",
              name: null,
              data: '{"delta":"x"}',
              atMillis: 1001 + seq,
            }),
          { discard: true },
        );
        const mutationStart = (yield* Ref.get(statements)).length;

        yield* ledger.updateRun(id, {
          status: "succeeded",
          usage: null,
          endedAtMillis: 2000,
        });

        const mutationStatements = (yield* Ref.get(statements)).slice(mutationStart);
        assert.strictEqual(mutationStatements.length, 2);
        assert.isFalse(mutationStatements.some((statement) => statement.includes("run_events")));
      }),
    );
  });
});
