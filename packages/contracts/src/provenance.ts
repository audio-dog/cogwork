import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./base-schemas";

export class ContentRevision extends Schema.TaggedClass<ContentRevision>()("ContentRevision", {
  source: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
}) {}

export class DeclaredVersion extends Schema.TaggedClass<DeclaredVersion>()("DeclaredVersion", {
  source: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
}) {}

export const ProvenanceStamp = Schema.Union([ContentRevision, DeclaredVersion]);
export type ProvenanceStamp = typeof ProvenanceStamp.Type;
