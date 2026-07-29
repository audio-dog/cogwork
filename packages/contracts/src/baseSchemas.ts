import * as Schema from "effect/Schema";

export const TrimmedString = Schema.Trim;

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

const makeEntityId = <Brand extends string>(brand: Brand) => TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkspaceId = makeEntityId("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkItemId = makeEntityId("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;
