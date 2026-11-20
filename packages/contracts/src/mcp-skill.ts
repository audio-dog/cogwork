import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./base-schemas";

// A reference, not the secret: the engine resolves the bearer late from the credential store. Keep
// this a reference — a plaintext token field here would ride the config into the ledger and the log.
export const McpSkillAuth = Schema.Struct({
  type: Schema.Literal("credential-store"),
});
export type McpSkillAuth = typeof McpSkillAuth.Type;

export const McpSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  endpoint: TrimmedNonEmptyString,
  auth: Schema.optional(McpSkillAuth),
});
export type McpSkill = typeof McpSkill.Type;
