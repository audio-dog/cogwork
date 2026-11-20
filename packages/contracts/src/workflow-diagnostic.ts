import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./base-schemas";
import { WorkflowDocument, WorkflowNodeId } from "./workflow";

export const WorkflowDiagnosticCode = Schema.Literals([
  "schema",
  "unknown-target",
  "duplicate-id",
  "duplicate-transition",
  "unknown-reference",
  "self-hand-off",
  "unknown-catalog-entry",
  "unknown-option",
  "unknown-model",
  "no-trigger",
  "uncovered-outcome",
  "conflicting-hand-offs",
  "empty-instruction",
  "missing-option",
  "profile-too-narrow",
  "no-workspace",
  "item-kind-mismatch",
  "filter-not-applicable",
  "connection-not-ready",
  "need-not-ready",
  "harness-unavailable",
  "no-harness",
  "workspace-not-registered",
  "system-unbound",
  "unreachable-operation",
  "option-not-listed",
  "hand-off-and-trigger",
]);
export type WorkflowDiagnosticCode = typeof WorkflowDiagnosticCode.Type;

export const WorkflowDiagnosticClass = Schema.Literals(["malformed", "incomplete", "advisory"]);
export type WorkflowDiagnosticClass = typeof WorkflowDiagnosticClass.Type;

export const WorkflowDiagnosticLocation = Schema.Struct({
  trigger: Schema.NullOr(WorkflowNodeId),
  operation: Schema.NullOr(WorkflowNodeId),
  question: Schema.NullOr(WorkflowNodeId),
  choice: Schema.NullOr(WorkflowNodeId),
  field: Schema.String,
});
export type WorkflowDiagnosticLocation = typeof WorkflowDiagnosticLocation.Type;

export const WorkflowDiagnostic = Schema.Struct({
  code: WorkflowDiagnosticCode,
  class: WorkflowDiagnosticClass,
  location: WorkflowDiagnosticLocation,
  message: TrimmedNonEmptyString,
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;

const rootLocation: WorkflowDiagnosticLocation = {
  trigger: null,
  operation: null,
  question: null,
  choice: null,
  field: "document",
} satisfies WorkflowDiagnosticLocation;

export const location = (
  field: string,
  values: Partial<Pick<WorkflowDiagnosticLocation, "trigger" | "operation" | "question" | "choice">> = {},
) => ({ ...rootLocation, ...values, field });

export const diagnostic = (
  code: WorkflowDiagnosticCode,
  diagnosticClass: WorkflowDiagnosticClass,
  message: string,
  diagnosticLocation: WorkflowDiagnosticLocation = rootLocation,
) => ({ code, class: diagnosticClass, location: diagnosticLocation, message }) satisfies WorkflowDiagnostic;

export const unknownTarget = (target: string, field: string) =>
  diagnostic("unknown-target", "malformed", `No ${field} has id ${target}`, location(field));

export type Decoded<A> =
  | { readonly _tag: "Ok"; readonly value: A }
  | { readonly _tag: "Refused"; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

export const ok = <A>(value: A): Decoded<A> => ({ _tag: "Ok", value });

export const refused = <A>(diagnostics: ReadonlyArray<WorkflowDiagnostic>): Decoded<A> => ({
  _tag: "Refused",
  diagnostics,
});

export const decodeWorkflowDocumentValue = (input: unknown) => {
  const decoded = Schema.decodeUnknownExit(WorkflowDocument, {
    errors: "all",
    onExcessProperty: "error",
  })(input);
  return Exit.isFailure(decoded)
    ? refused<WorkflowDocument>([
        diagnostic("schema", "malformed", Cause.pretty(decoded.cause), location("document")),
      ])
    : ok(decoded.value);
};
