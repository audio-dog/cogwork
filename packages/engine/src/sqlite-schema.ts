import type { Hint } from "drizzle-kit/payload/sqlite";
import * as DrizzleSqlite from "drizzle-kit/payload/sqlite";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class SqliteSchemaDiffError extends Data.TaggedError("SqliteSchemaDiffError")<{
  readonly reason: "rename-shaped" | "diff";
  readonly message: string;
}> {}

const DataLossConfirmation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("confirm_data_loss"),
    kind: Schema.Literal("table"),
    entity: Schema.Tuple([Schema.String, Schema.String]),
  }),
  Schema.Struct({
    type: Schema.Literal("confirm_data_loss"),
    kind: Schema.Literals(["column", "add_not_null"]),
    entity: Schema.Tuple([Schema.String, Schema.String, Schema.String]),
  }),
]);

// drizzle-kit exports `MissingHintsError` as a type only, so its shape is decoded.
const MissingHints = Schema.Struct({
  code: Schema.Literal("missing_hints"),
  missingHints: Schema.Array(Schema.Struct({ type: Schema.String })),
});
const DataLossOnly = Schema.Struct({
  code: Schema.Literal("missing_hints"),
  missingHints: Schema.Array(DataLossConfirmation),
});
const isMissingHints = Schema.is(MissingHints);
const decodeDataLossConfirmations = Schema.decodeUnknownOption(DataLossOnly);

class UnconfirmedDataLoss extends Data.TaggedError("UnconfirmedDataLoss")<{
  readonly confirmations: ReadonlyArray<typeof DataLossConfirmation.Type>;
  readonly message: string;
}> {}

const diffFailure = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const dataLoss = decodeDataLossConfirmations(error);
  if (Option.isSome(dataLoss))
    return new UnconfirmedDataLoss({ confirmations: dataLoss.value.missingHints, message });
  const renameShaped =
    isMissingHints(error) && error.missingHints.some((hint) => hint.type === "rename_or_create");
  return new SqliteSchemaDiffError({ reason: renameShaped ? "rename-shaped" : "diff", message });
};

const confirmedDiffFailure = (error: UnconfirmedDataLoss | SqliteSchemaDiffError) => {
  if (error._tag === "SqliteSchemaDiffError") return error;
  return new SqliteSchemaDiffError({ reason: "diff", message: error.message });
};

export const statements = Effect.fn("SqliteSchema.statements")(function* (schema: Record<string, unknown>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const runPromise = yield* FiberSet.makeRuntimePromise();
      const database = {
        query: <T = never>(query: string, params: ReadonlyArray<unknown> = []) =>
          runPromise(sql.unsafe<T & object>(query, params)).then((rows) => rows.map((row) => row)),
        run: (query: string) => runPromise(sql.unsafe(query)).then(() => undefined),
        batch: (statements: ReadonlyArray<string>) =>
          runPromise(
            Effect.forEach(statements, (statement) => sql.unsafe(statement), {
              discard: true,
            }),
          ).then(() => undefined),
      };
      const diff = (hints: Array<Hint>) =>
        Effect.tryPromise({
          try: () => DrizzleSqlite.pushSchema(schema, database, undefined, { hints }),
          catch: diffFailure,
        });
      // A schema convergence accepts the data loss that a drop or a table recreate causes, so the
      // diff is run again with each of those confirmed. A rename question has no safe answer here.
      const result = yield* diff([]).pipe(
        Effect.catchTag("UnconfirmedDataLoss", ({ confirmations }) =>
          diff([...confirmations]).pipe(Effect.mapError(confirmedDiffFailure)),
        ),
      );
      return result.sqlStatements;
    }),
  );
});
