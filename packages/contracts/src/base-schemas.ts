import * as Schema from "effect/Schema";

export const TrimmedString = Schema.Trim;

export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

const makeBrand = <Brand extends string>(brand: Brand) => TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const WorkspaceId = makeBrand("WorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkItemId = makeBrand("WorkItemId");
export type WorkItemId = typeof WorkItemId.Type;

export const HarnessName = makeBrand("HarnessName");
export type HarnessName = typeof HarnessName.Type;

export const WorkSourceType = makeBrand("WorkSourceType");
export type WorkSourceType = typeof WorkSourceType.Type;

export const SourceControlType = makeBrand("SourceControlType");
export type SourceControlType = typeof SourceControlType.Type;
