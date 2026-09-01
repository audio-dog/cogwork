import * as Schema from "effect/Schema";

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  reason: Schema.Literals([
    "invalid-args",
    "out-of-bounds",
    "not-found",
    "read-failed",
    "write-failed",
    "edit-no-match",
    "edit-ambiguous",
    "exec-failed",
    "fetch-failed",
    "timeout",
  ]),
  path: Schema.NullOr(Schema.String),
  message: Schema.String,
}) {}

export const toolError = (reason: ToolError["reason"], message: string, path: string | null = null) =>
  new ToolError({ reason, message, path });
