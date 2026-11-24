import { SqliteSchema } from "@cogwork/engine";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { lt, sql } from "drizzle-orm";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Formatter from "effect/Formatter";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tracer from "effect/Tracer";

const pageSize = 4096;
const spanBatchSize = 1000;
const spanBufferCapacity = 10_000;
const sqliteBindParameterLimit = 999;
const spanInsertChunkSize = Math.floor(sqliteBindParameterLimit / 8);
const metricInsertChunkSize = Math.floor(sqliteBindParameterLimit / 5);

const rowsWritten = Metric.counter("cogwork_telemetry_rows_written_total", {
  description: "Rows written to the local telemetry store.",
});
const writeDuration = Metric.timer("cogwork_telemetry_write_duration", {
  description: "Time spent writing local telemetry batches.",
});
const spansDropped = Metric.counter("cogwork_telemetry_spans_dropped_total", {
  description: "Spans dropped when the local telemetry buffer is full.",
});

interface SpanRow {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: string | null;
  readonly start: number;
  readonly duration: number;
  readonly exit: "success" | "interrupt" | "failure";
  readonly attributes: Readonly<Record<string, unknown>>;
}

interface MetricRow {
  readonly timestamp: number;
  readonly name: string;
  readonly type: Metric.Metric.Type;
  readonly attributes: string;
  readonly state: string;
}

export interface LocalTelemetryOptions {
  readonly storePath: string;
  readonly snapshotInterval: Duration.Input;
  readonly maintenanceInterval: Duration.Input;
  readonly retention: Duration.Input;
  readonly sizeCapBytes: number;
}

const spanTable = sqliteTable(
  "spans",
  {
    name: text("name").notNull(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    parent: text("parent"),
    start: integer("start").notNull(),
    duration: real("duration").notNull(),
    exit: text("exit").notNull(),
    attributes: text("attributes").notNull(),
  },
  (table) => [
    check("spans_attributes_json", sql`json_valid(${table.attributes})`),
    index("spans_name_start").on(table.name, table.start),
    index("spans_start").on(table.start),
  ],
);

const metricTable = sqliteTable(
  "metrics",
  {
    timestamp: integer("timestamp").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    attributes: text("attributes").notNull(),
    state: text("state").notNull(),
  },
  (table) => [
    check("metrics_attributes_json", sql`json_valid(${table.attributes})`),
    check("metrics_state_json", sql`json_valid(${table.state})`),
    index("metrics_name_timestamp").on(table.name, table.timestamp),
    index("metrics_timestamp").on(table.timestamp),
  ],
);

const telemetryStoreSchema = { spanTable, metricTable };

class TelemetryStoreSchemaError extends Data.TaggedError("TelemetryStoreSchemaError")<{
  readonly message: string;
}> {}

const telemetryStoreSchemaStatements = Effect.fn("TelemetryStore.schemaStatements")(function* () {
  return yield* SqliteSchema.statements(telemetryStoreSchema).pipe(
    Effect.mapError(
      (error) =>
        new TelemetryStoreSchemaError({ message: `Telemetry store schema diff failed: ${error.message}` }),
    ),
  );
});

const foreignKeysPragma = /^PRAGMA foreign_keys\s*=\s*(?:ON|OFF);?$/i;

const applySchemaStatements = Effect.fn("TelemetryStore.applySchemaStatements")(function* (
  statements: ReadonlyArray<string>,
) {
  if (statements.length === 0) return;
  const sqlClient = yield* SqlClient.SqlClient;
  const schemaChanges = statements.filter((statement) => !foreignKeysPragma.test(statement));
  const disablesForeignKeys = statements.some((statement) => /foreign_keys\s*=\s*OFF/i.test(statement));
  const applyChanges = sqlClient.withTransaction(
    Effect.forEach(schemaChanges, (statement) => sqlClient.unsafe(statement), { discard: true }),
  );
  if (!disablesForeignKeys) return yield* applyChanges;
  yield* sqlClient.unsafe("PRAGMA foreign_keys = OFF");
  yield* applyChanges.pipe(Effect.ensuring(Effect.ignore(sqlClient.unsafe("PRAGMA foreign_keys = ON"))));
});

const convergeSchema = Effect.fn("TelemetryStore.convergeSchema")(function* () {
  const statements = yield* telemetryStoreSchemaStatements();
  if (statements.length === 0) return;
  yield* applySchemaStatements(statements);
  const remaining = yield* telemetryStoreSchemaStatements();
  if (remaining.length === 0) return;
  return yield* new TelemetryStoreSchemaError({
    message: `Telemetry store schema did not converge:\n${remaining.join("\n")}`,
  });
});

const prepareStoreDirectory = Effect.fn("TelemetryStore.prepareDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(storePath);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
});

const clientLayer = (storePath: string) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () =>
      SqliteClient.layer({ filename: storePath, busyTimeout: "5 seconds" }),
    ),
  );

const logWriteFailure = (operation: string) =>
  Effect.catchCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
    return Effect.logWarning(`local telemetry ${operation} failed`, { cause: Cause.pretty(cause) });
  });

const metricState = (snapshot: Metric.Metric.Snapshot) => {
  if (snapshot.type === "Frequency") {
    return { occurrences: Object.fromEntries(snapshot.state.occurrences) };
  }
  return snapshot.state;
};

const formatJson = (value: unknown, fallback: string) => {
  try {
    return Formatter.formatJson(value);
  } catch {
    return fallback;
  }
};

const chunksOf = <A>(values: ReadonlyArray<A>, size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

const snapshotAttribute = (value: unknown) => {
  try {
    return structuredClone(value);
  } catch {
    return "[unserializable]";
  }
};

const metricRows = (timestamp: number, snapshots: ReadonlyArray<Metric.Metric.Snapshot>) =>
  snapshots.map((snapshot) => ({
    timestamp,
    name: snapshot.id,
    type: snapshot.type,
    attributes: formatJson(snapshot.attributes ?? {}, "{}"),
    state: formatJson(metricState(snapshot), "null"),
  }));

const exitOf = (span: Tracer.Span) => {
  if (span.status._tag !== "Ended" || span.status.exit._tag === "Success") return "success" as const;
  if (Cause.hasInterruptsOnly(span.status.exit.cause)) return "interrupt" as const;
  return "failure" as const;
};

const spanRow = (span: Tracer.Span) => {
  if (span.status._tag !== "Ended") return null;
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parent: Option.getOrUndefined(span.parent)?.spanId ?? null,
    start: Number(span.status.startTime / 1_000_000n),
    duration: Number(span.status.endTime - span.status.startTime) / 1_000_000,
    exit: exitOf(span),
    attributes: Object.fromEntries(
      Array.from(span.attributes, ([key, value]) => [key, snapshotAttribute(value)]),
    ),
  };
};

class PersistedSpan implements Tracer.Span {
  readonly _tag = "Span" as const;

  constructor(
    private readonly span: Tracer.Span,
    private readonly queue: Queue.Enqueue<SpanRow>,
    private readonly metricContext: Context.Context<never>,
  ) {}

  get name() {
    return this.span.name;
  }

  get spanId() {
    return this.span.spanId;
  }

  get traceId() {
    return this.span.traceId;
  }

  get parent() {
    return this.span.parent;
  }

  get annotations() {
    return this.span.annotations;
  }

  get status() {
    return this.span.status;
  }

  get attributes() {
    return this.span.attributes;
  }

  get links() {
    return this.span.links;
  }

  get sampled() {
    return this.span.sampled;
  }

  get kind() {
    return this.span.kind;
  }

  end(endTime: bigint, exit: Parameters<Tracer.Span["end"]>[1]) {
    this.span.end(endTime, exit);
    const row = spanRow(this);
    if (row && !Queue.offerUnsafe(this.queue, row)) spansDropped.updateUnsafe(1, this.metricContext);
  }

  attribute(key: string, value: unknown) {
    this.span.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.span.event(name, startTime, attributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>) {
    this.span.addLinks(links);
  }
}

const makeTracer = (
  upstream: Tracer.Tracer,
  queue: Queue.Enqueue<SpanRow>,
  metricContext: Context.Context<never>,
) =>
  Tracer.make({
    span: (options) => new PersistedSpan(upstream.span(options), queue, metricContext),
    context: upstream.context?.bind(upstream),
  });

const makeStore = Effect.fn("TelemetryStore.make")(function* (options: LocalTelemetryOptions) {
  const db = yield* SQLiteNodeDrizzle.makeWithDefaults();
  const fs = yield* FileSystem.FileSystem;
  const writeGate = Semaphore.makeUnsafe(1);
  const maxPages = Math.max(1, Math.floor(options.sizeCapBytes / pageSize));
  yield* db.run(`PRAGMA page_size = ${pageSize}`);
  yield* db.run(`PRAGMA max_page_count = ${maxPages}`);
  yield* convergeSchema();
  yield* fs.chmod(options.storePath, 0o600);

  const instrumentWrite =
    (count: number, operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      writeGate
        .withPermits(1)(effect)
        .pipe(
          Effect.trackDuration(writeDuration),
          Effect.andThen(Metric.update(rowsWritten, count)),
          logWriteFailure(operation),
        );

  const writeSpans = Effect.fn("TelemetryStore.writeSpans")(
    function* (spans: ReadonlyArray<SpanRow>) {
      if (spans.length === 0) return;
      const rows = spans.map((span) => ({
        ...span,
        attributes: formatJson(span.attributes, "{}"),
      }));
      yield* db.transaction((tx) =>
        Effect.forEach(
          chunksOf(rows, spanInsertChunkSize),
          (chunk) => tx.insert(spanTable).values(chunk).run(),
          { discard: true },
        ),
      );
    },
    (effect, spans) => instrumentWrite(spans.length, "span write")(effect),
  );

  const writeMetrics = Effect.fn("TelemetryStore.writeMetrics")(
    function* (metrics: ReadonlyArray<MetricRow>) {
      if (metrics.length === 0) return;
      yield* db.transaction((tx) =>
        Effect.forEach(
          chunksOf(metrics, metricInsertChunkSize),
          (chunk) => tx.insert(metricTable).values(chunk).run(),
          { discard: true },
        ),
      );
    },
    (effect, metrics) => instrumentWrite(metrics.length, "metric write")(effect),
  );

  const captureMetrics = Effect.fn("TelemetryStore.captureMetrics")(function* () {
    const timestamp = yield* Clock.currentTimeMillis;
    yield* writeMetrics(metricRows(timestamp, yield* Metric.snapshot));
  });

  const prune = Effect.fn("TelemetryStore.prune")(
    function* () {
      const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(options.retention);
      yield* db.transaction((tx) =>
        tx
          .delete(spanTable)
          .where(lt(spanTable.start, cutoff))
          .run()
          .pipe(Effect.andThen(tx.delete(metricTable).where(lt(metricTable.timestamp, cutoff)).run())),
      );
      const [{ page_count: pages } = { page_count: 0 }] = yield* db.all<{
        readonly page_count: number;
      }>(sql.raw("PRAGMA page_count"));
      const [{ freelist_count: freePages } = { freelist_count: 0 }] = yield* db.all<{
        readonly freelist_count: number;
      }>(sql.raw("PRAGMA freelist_count"));
      const overSizeTarget = pages - freePages >= Math.floor(maxPages * 0.9);
      if (overSizeTarget) {
        yield* db.transaction((tx) =>
          tx
            .delete(spanTable)
            .where(
              sql`rowid IN (
                SELECT rowid FROM ${spanTable}
                ORDER BY ${spanTable.start}
                LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM ${spanTable})
              )`,
            )
            .run()
            .pipe(
              Effect.andThen(
                tx
                  .delete(metricTable)
                  .where(
                    sql`rowid IN (
                      SELECT rowid FROM ${metricTable}
                      ORDER BY ${metricTable.timestamp}
                      LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM ${metricTable})
                    )`,
                  )
                  .run(),
              ),
            ),
        );
      }
      yield* db.run(sql.raw("PRAGMA wal_checkpoint(PASSIVE)"));
    },
    (effect) => writeGate.withPermits(1)(effect).pipe(logWriteFailure("retention")),
  );

  return { writeSpans, captureMetrics, prune };
});

function makeLocalTracer(options: LocalTelemetryOptions) {
  return Effect.gen(function* () {
    const upstream = yield* Tracer.Tracer;
    const store = yield* makeStore(options);
    const metricContext = yield* Effect.context<never>();
    const queue = yield* Queue.dropping<SpanRow>(spanBufferCapacity);
    yield* Effect.addFinalizer(() =>
      Queue.clear(queue).pipe(
        Effect.flatMap(store.writeSpans),
        Effect.andThen(store.captureMetrics()),
        Effect.andThen(store.prune()),
      ),
    );
    yield* Effect.uninterruptibleMask((restore) =>
      restore(Queue.takeBetween(queue, 1, spanBatchSize)).pipe(Effect.flatMap(store.writeSpans)),
    ).pipe(Effect.forever, logWriteFailure("span worker"), Effect.forkScoped);
    yield* store
      .captureMetrics()
      .pipe(
        Effect.repeat(Schedule.spaced(options.snapshotInterval)),
        logWriteFailure("metric worker"),
        Effect.forkScoped,
      );
    yield* store
      .prune()
      .pipe(
        Effect.repeat(Schedule.spaced(options.maintenanceInterval)),
        logWriteFailure("maintenance worker"),
        Effect.forkScoped,
      );
    return makeTracer(upstream, queue, metricContext);
  });
}

const fallbackTracerLayer = (cause: Cause.Cause<unknown>) =>
  Layer.effect(
    Tracer.Tracer,
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.gen(function* () {
          yield* Effect.logWarning("local telemetry initialization failed", {
            cause: Cause.pretty(cause),
          });
          return yield* Tracer.Tracer;
        }),
  );

export const localTelemetryLayer = (options: LocalTelemetryOptions) =>
  Layer.effect(Tracer.Tracer, makeLocalTracer(options)).pipe(
    Layer.provide(clientLayer(options.storePath)),
    Layer.catchCause(fallbackTracerLayer),
  );
