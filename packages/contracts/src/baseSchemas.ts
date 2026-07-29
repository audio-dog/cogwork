import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const TrimmedString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
);

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const makeEntityId = <Brand extends string>(brand: Brand) => TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkspaceId = makeEntityId("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkItemId = makeEntityId("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;
