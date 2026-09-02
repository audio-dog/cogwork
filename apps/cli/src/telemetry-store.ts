import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import type * as Context from "effect/Context";
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
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const pageSize = 4096;
const spanBatchSize = 1000;
const spanBufferCapacity = 10_000;

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

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS spans (
    name TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    span_id TEXT NOT NULL,
    parent TEXT,
    start INTEGER NOT NULL,
    duration REAL NOT NULL,
    exit TEXT NOT NULL,
    attributes TEXT NOT NULL CHECK (json_valid(attributes))
  )`,
  "CREATE INDEX IF NOT EXISTS spans_name_start ON spans (name, start)",
  "CREATE INDEX IF NOT EXISTS spans_start ON spans (start)",
  `CREATE TABLE IF NOT EXISTS metrics (
    timestamp INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    attributes TEXT NOT NULL CHECK (json_valid(attributes)),
    state TEXT NOT NULL CHECK (json_valid(state))
  )`,
  "CREATE INDEX IF NOT EXISTS metrics_name_timestamp ON metrics (name, timestamp)",
  "CREATE INDEX IF NOT EXISTS metrics_timestamp ON metrics (timestamp)",
];

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
  readonly _tag: "Span" = "Span";

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
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const writeGate = Semaphore.makeUnsafe(1);
  const maxPages = Math.max(1, Math.floor(options.sizeCapBytes / pageSize));
  yield* sql.unsafe(`PRAGMA page_size = ${pageSize}`);
  yield* sql.unsafe(`PRAGMA max_page_count = ${maxPages}`);
  yield* Effect.forEach(schemaStatements, (statement) => sql.unsafe(statement), { discard: true });
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
      yield* sql.withTransaction(
        Effect.forEach(
          spans,
          (span) => sql`
          INSERT INTO spans (name, trace_id, span_id, parent, start, duration, exit, attributes)
          VALUES (${span.name}, ${span.traceId}, ${span.spanId}, ${span.parent}, ${span.start}, ${span.duration}, ${span.exit}, ${formatJson(span.attributes, "{}")})
        `,
          { discard: true },
        ),
      );
    },
    (effect, spans) => instrumentWrite(spans.length, "span write")(effect),
  );

  const writeMetrics = Effect.fn("TelemetryStore.writeMetrics")(
    function* (metrics: ReadonlyArray<MetricRow>) {
      if (metrics.length === 0) return;
      yield* sql.withTransaction(
        Effect.forEach(
          metrics,
          (metric) => sql`
          INSERT INTO metrics (timestamp, name, type, attributes, state)
          VALUES (${metric.timestamp}, ${metric.name}, ${metric.type}, ${metric.attributes}, ${metric.state})
        `,
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
      yield* sql.withTransaction(
        Effect.all(
          [
            sql`DELETE FROM spans WHERE start < ${cutoff}`,
            sql`DELETE FROM metrics WHERE timestamp < ${cutoff}`,
          ],
          { discard: true },
        ),
      );
      const [{ page_count: pages } = { page_count: 0 }] = yield* sql.unsafe<{
        readonly page_count: number;
      }>("PRAGMA page_count");
      const [{ freelist_count: freePages } = { freelist_count: 0 }] = yield* sql.unsafe<{
        readonly freelist_count: number;
      }>("PRAGMA freelist_count");
      const overSizeTarget = pages - freePages >= Math.floor(maxPages * 0.9);
      if (overSizeTarget) {
        yield* sql.withTransaction(
          Effect.all(
            [
              sql`DELETE FROM spans WHERE rowid IN (
                SELECT rowid FROM spans ORDER BY start LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM spans)
              )`,
              sql`DELETE FROM metrics WHERE rowid IN (
                SELECT rowid FROM metrics ORDER BY timestamp LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM metrics)
              )`,
            ],
            { discard: true },
          ),
        );
      }
      yield* sql.unsafe("PRAGMA wal_checkpoint(PASSIVE)");
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
