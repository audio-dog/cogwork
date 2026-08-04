import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./base-schemas";

export const McpSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
});
export type McpSkill = typeof McpSkill.Type;
