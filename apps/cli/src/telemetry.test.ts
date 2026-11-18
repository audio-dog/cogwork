import { DatabaseSync } from "node:sqlite";
import * as Resource from "@effect/opentelemetry/Resource";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import type * as NetAddress from "effect/net/NetAddress";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import { telemetryLayer } from "./telemetry";

const requests = Metric.counter("cogwork_telemetry_test_requests_total", {
  description: "Requests emitted by the telemetry integration test.",
});

const configLayer = (env: Readonly<Record<string, string>> = {}) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

const collectorEndpoint = (address: NetAddress.SocketAddress) =>
  address._tag === "UnixPathAddress"
    ? Effect.die("collector address unavailable")
    : Effect.succeed(`http://127.0.0.1:${address.port}`);

const query = (storePath: string, statement: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) => Effect.sync(() => database.prepare(statement).all()),
    (database) => Effect.sync(() => database.close()),
  );

const update = (storePath: string, statement: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new DatabaseSync(storePath)),
    (database) => Effect.sync(() => database.exec(statement)),
    (database) => Effect.sync(() => database.close()),
  );

const temporaryStore = Effect.fn("telemetry.test.temporaryStore")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-telemetry-" });
  return path.join(dir, "telemetry.db");
});

const localLayer = (storePath: string, enabled = true, sizeCapBytes = 1024 * 1024) =>
  telemetryLayer({
    enabled,
    storePath,
    snapshotInterval: "1 hour",
    maintenanceInterval: "1 hour",
    retention: "7 days",
    sizeCapBytes,
  }).pipe(Layer.provide(configLayer()));

describe("telemetryLayer", () => {
  it.layer(
    telemetryLayer({ enabled: false }).pipe(
      Layer.provide(configLayer({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1" })),
      Layer.provide(NodeServices.layer),
    ),
  )((it) => {
    it.effect("stays empty when disabled despite an endpoint", () =>
      Effect.gen(function* () {
        const resource = yield* Resource.Resource;
        assert.deepEqual(resource.getRawAttributes(), []);
      }),
    );
  });

  it.layer(NodeHttpServer.layerTest.pipe(Layer.provideMerge(NodeServices.layer)))((it) => {
    it.effect("exports through OTLP while persisting locally", () =>
      Effect.gen(function* () {
        const storePath = yield* temporaryStore();
        const paths = yield* Ref.make<ReadonlySet<string>>(new Set());
        yield* HttpRouter.add(
          "*",
          "*",
          HttpServerRequest.HttpServerRequest.pipe(
            Effect.flatMap((request) =>
              Ref.update(paths, (seen) => new Set([...seen, request.url])).pipe(
                Effect.map(() => HttpServerResponse.empty({ status: 200 })),
              ),
            ),
          ),
        ).pipe(HttpRouter.serve, Layer.build);
        const server = yield* HttpServer.HttpServer;
        const endpoint = yield* collectorEndpoint(server.address);
        const tracesEndpoint = `${endpoint}/custom/traces`;
        yield* Effect.all([Effect.logInfo("telemetry test"), Metric.update(requests, 1)], {
          discard: true,
        }).pipe(
          Effect.withSpan("telemetry test"),
          Effect.provide(
            telemetryLayer({
              storePath,
              snapshotInterval: "1 hour",
              maintenanceInterval: "1 hour",
            }).pipe(
              Layer.provide(
                configLayer({
                  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
                  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesEndpoint,
                }),
              ),
            ),
          ),
          Effect.scoped,
        );

        assert.deepEqual(yield* Ref.get(paths), new Set(["/custom/traces", "/v1/metrics", "/v1/logs"]));
        assert.deepEqual(yield* query(storePath, "SELECT name FROM spans WHERE name = 'telemetry test'"), [
          { name: "telemetry test" },
        ]);
      }),
    );
  });
});

describe("local telemetry", () => {
  it.live("persists ended spans and metric snapshots in its own SQLite store", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const localRequests = Metric.counter("cogwork_local_telemetry_test_requests_total");

      yield* Effect.all(
        [
          Effect.succeed("done").pipe(
            Effect.withSpan("Telemetry.testOperation"),
            Effect.annotateSpans({ workspace: "test" }),
          ),
          Metric.update(localRequests, 1),
        ],
        { discard: true },
      ).pipe(Effect.provide(localLayer(storePath)), Effect.scoped);

      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT name, exit, json_extract(attributes, '$.workspace') AS workspace FROM spans WHERE name = 'Telemetry.testOperation'",
        ),
        [{ name: "Telemetry.testOperation", exit: "success", workspace: "test" }],
      );
      assert.deepEqual(yield* query(storePath, "SELECT DISTINCT name FROM spans ORDER BY name"), [
        { name: "Telemetry.testOperation" },
      ]);
      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT name, type FROM metrics WHERE name IN ('cogwork_local_telemetry_test_requests_total', 'cogwork_telemetry_rows_written_total', 'cogwork_telemetry_write_duration') ORDER BY name",
        ),
        [
          { name: "cogwork_local_telemetry_test_requests_total", type: "Counter" },
          { name: "cogwork_telemetry_rows_written_total", type: "Counter" },
          { name: "cogwork_telemetry_write_duration", type: "Histogram" },
        ],
      );
      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('spans', 'metrics') ORDER BY name",
        ),
        [{ name: "metrics" }, { name: "spans" }],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("updates an existing local store without losing telemetry", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const start = yield* Clock.currentTimeMillis;
      yield* update(
        storePath,
        `CREATE TABLE spans (
          name TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          start INTEGER NOT NULL,
          duration REAL NOT NULL,
          exit TEXT NOT NULL,
          attributes TEXT NOT NULL CONSTRAINT spans_attributes_json CHECK (json_valid(attributes))
        );
        INSERT INTO spans (name, trace_id, span_id, start, duration, exit, attributes)
        VALUES ('Telemetry.existing', 'trace', 'span', ${start}, 1, 'success', '{}');`,
      );

      yield* Effect.void.pipe(Effect.provide(localLayer(storePath)), Effect.scoped);

      assert.isTrue(
        (yield* query(storePath, "PRAGMA table_info(spans)")).some((column) => column.name === "parent"),
      );
      assert.deepEqual(yield* query(storePath, "SELECT name FROM spans WHERE name = 'Telemetry.existing'"), [
        { name: "Telemetry.existing" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("flushes a dequeued partial span batch during shutdown", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();

      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.shutdownFlush"),
        Effect.andThen(Effect.sleep("100 millis")),
        Effect.provide(localLayer(storePath)),
        Effect.scoped,
      );

      assert.deepEqual(
        yield* query(storePath, "SELECT name FROM spans WHERE name = 'Telemetry.shutdownFlush'"),
        [{ name: "Telemetry.shutdownFlush" }],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("does not create or write the local store when disabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storePath = yield* temporaryStore();

      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.disabledOperation"),
        Effect.provide(localLayer(storePath, false)),
        Effect.scoped,
      );

      assert.isFalse(yield* fs.exists(storePath));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("keeps telemetry available when the local store cannot initialize", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-telemetry-blocked-" });
      const blockedDirectory = path.join(dir, "blocked");
      yield* fs.writeFileString(blockedDirectory, "not a directory");

      const result = yield* Effect.succeed("started").pipe(
        Effect.withSpan("Telemetry.unavailableStore"),
        Effect.provide(localLayer(path.join(blockedDirectory, "telemetry.db"))),
        Effect.scoped,
      );

      assert.strictEqual(result, "started");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("persists a span when an attribute cannot be serialized", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.unserializableAttribute"),
        Effect.annotateSpans({
          invalid: {
            toJSON() {
              throw new Error("cannot serialize");
            },
          },
        }),
        Effect.provide(localLayer(storePath)),
        Effect.scoped,
      );

      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT attributes FROM spans WHERE name = 'Telemetry.unserializableAttribute'",
        ),
        [{ attributes: '{"invalid":"[unserializable]"}' }],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("snapshots attributes when the span ends", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const payload = { phase: "at-end" };
      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.attributeSnapshot"),
        Effect.annotateSpans({ payload }),
        Effect.andThen(Effect.sync(() => Object.assign(payload, { phase: "after-end" }))),
        Effect.provide(localLayer(storePath)),
        Effect.scoped,
      );

      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT json_extract(attributes, '$.payload.phase') AS phase FROM spans WHERE name = 'Telemetry.attributeSnapshot'",
        ),
        [{ phase: "at-end" }],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("drops excess spans instead of growing the in-memory buffer", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const baseStartTime = yield* Clock.currentTimeNanos;
      yield* Tracer.Tracer.pipe(
        Effect.flatMap((tracer) =>
          Effect.sync(() => {
            Array.from({ length: 10_001 }, (_, index) => index).forEach((index) => {
              const startTime = baseStartTime + BigInt(index);
              tracer
                .span({
                  name: `Telemetry.buffer.${index}`,
                  parent: Option.none(),
                  annotations: Context.empty(),
                  links: [],
                  startTime,
                  kind: "internal",
                  root: true,
                  sampled: true,
                })
                .end(startTime + 1n, Exit.void);
            });
          }),
        ),
        Effect.provide(localLayer(storePath, true, 32 * 1024 * 1024)),
        Effect.scoped,
      );

      assert.deepEqual(
        yield* query(
          storePath,
          "SELECT json_extract(state, '$.count') AS count FROM metrics WHERE name = 'cogwork_telemetry_spans_dropped_total' ORDER BY timestamp DESC LIMIT 1",
        ),
        [{ count: 1 }],
      );
      assert.deepEqual(
        yield* query(storePath, "SELECT COUNT(*) AS count FROM spans WHERE name LIKE 'Telemetry.buffer.%'"),
        [{ count: 10_000 }],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("keeps fresh evidence when expired rows relieve size pressure", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      yield* Effect.void.pipe(Effect.provide(localLayer(storePath)), Effect.scoped);
      yield* update(
        storePath,
        `WITH RECURSIVE rows(n) AS (
          VALUES(1)
          UNION ALL
          SELECT n + 1 FROM rows WHERE n < 450
        )
        INSERT INTO metrics (timestamp, name, type, attributes, state)
        SELECT 0, 'expired-probe-' || n, 'Gauge', '{}', json_quote(hex(randomblob(1000)))
        FROM rows;
        INSERT INTO metrics (timestamp, name, type, attributes, state)
        VALUES (CAST(unixepoch('now') AS INTEGER) * 1000 - 86400000, 'fresh-probe', 'Gauge', '{}', '1');`,
      );

      yield* Effect.void.pipe(Effect.provide(localLayer(storePath)), Effect.scoped);

      assert.deepEqual(yield* query(storePath, "SELECT name FROM metrics WHERE name = 'fresh-probe'"), [
        { name: "fresh-probe" },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("prunes expired evidence and enforces the configured page cap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const storePath = yield* temporaryStore();
      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.expiredOperation"),
        Effect.provide(localLayer(storePath)),
        Effect.scoped,
      );
      yield* update(storePath, "UPDATE spans SET start = 0; UPDATE metrics SET timestamp = 0;");
      yield* update(
        storePath,
        `WITH RECURSIVE rows(n) AS (
          VALUES(1)
          UNION ALL
          SELECT n + 1 FROM rows WHERE n < 450
        )
        INSERT INTO metrics (timestamp, name, type, attributes, state)
        SELECT 253402300799000, 'cap-probe-' || n, 'Gauge', '{}', json_quote(hex(randomblob(1000)))
        FROM rows`,
      );

      yield* Effect.succeed("done").pipe(
        Effect.withSpan("Telemetry.maintenanceOperation"),
        Effect.provide(localLayer(storePath)),
        Effect.scoped,
      );

      assert.deepEqual(yield* query(storePath, "SELECT COUNT(*) AS count FROM spans WHERE start = 0"), [
        { count: 0 },
      ]);
      assert.deepEqual(yield* query(storePath, "SELECT COUNT(*) AS count FROM metrics WHERE timestamp = 0"), [
        { count: 0 },
      ]);
      assert.isBelow(
        Number(
          (yield* query(storePath, "SELECT COUNT(*) AS count FROM metrics WHERE name LIKE 'cap-probe-%'"))[0]
            ?.count,
        ),
        450,
      );
      assert.isAtMost(Number((yield* fs.stat(storePath)).size), 1024 * 1024);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
