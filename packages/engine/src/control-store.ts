import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { createStatements } from "./control-store-create.gen";

export type ControlStoreStatus =
  | { readonly health: "available" }
  | { readonly health: "unavailable"; readonly message: string };
export const ControlStore = Context.Reference<ControlStoreStatus>(
  "@cogwork/engine/control-store/ControlStore",
  { defaultValue: () => ({ health: "unavailable", message: "Control store did not boot" }) },
);
export class ControlStoreBootError extends Data.TaggedError("ControlStoreBootError")<{
  readonly message: string;
}> {}

const maximumRunEventAgeMillis = 1000 * 60 * 60 * 24 * 30;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const schemaFingerprint = Effect.fn("ControlStore.schemaFingerprint")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%' ORDER BY type, name`;
  return rows.map((row) => `${row.type}:${row.name}:${row.sql ?? ""}`).join("\n");
});

const createSchema = Effect.fn("ControlStore.createSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const statement of createStatements) yield* sql.unsafe(statement);
});

const expectedSchemaFingerprint = Effect.fn("ControlStore.expectedSchemaFingerprint")(function* () {
  return yield* Effect.gen(function* () {
    yield* createSchema();
    return yield* schemaFingerprint();
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" })));
});

const retainRunEvents = Effect.fn("ControlStore.retainRunEvents")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`DELETE FROM run_events WHERE at < ${now - maximumRunEventAgeMillis}`;
});

// cogwork has no released version to migrate anyone from, so a store is created once and replaced
// whenever the schema moves. The comparison is exact because both sides run the same statements.
const boot = Effect.fn("ControlStore.boot")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.chmod(storePath, 0o600);
  const found = yield* schemaFingerprint();
  if (found === "") yield* createSchema();
  else if (found !== (yield* expectedSchemaFingerprint()))
    return yield* new ControlStoreBootError({
      message: `Control store schema does not match this build. Delete ${storePath} and start again.`,
    });
  yield* retainRunEvents();
});

// The directory has to exist, and be private, before the client opens the file inside it. `mode`
// applies only to a directory `makeDirectory` creates, so an existing one needs the explicit chmod.
const prepareStoreDirectory = Effect.fn("ControlStore.prepareStoreDirectory")(function* (storePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(storePath), { recursive: true, mode: 0o700 });
  yield* fs.chmod(path.dirname(storePath), 0o700);
});

export const controlStoreClientLayer = (storePath: string) =>
  Layer.unwrap(
    Effect.map(prepareStoreDirectory(storePath), () => SqliteClient.layer({ filename: storePath })),
  );

const available: ControlStoreStatus = { health: "available" };
const unavailable = (message: string): ControlStoreStatus => ({ health: "unavailable", message });

export const bootControlStoreLayer = (storePath: string) =>
  Layer.effect(
    ControlStore,
    boot(storePath).pipe(
      Effect.map(() => available),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.andThen(
          Effect.logError("control store boot failed", { cause: Cause.pretty(cause) }),
          Effect.succeed(
            unavailable(Cause.hasFails(cause) ? messageOf(Cause.squash(cause)) : Cause.pretty(cause)),
          ),
        );
      }),
    ),
  );
