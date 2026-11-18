import { WorkflowDocument } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

interface SchemaIssueNode {
  readonly _tag: string;
  readonly path?: ReadonlyArray<PropertyKey>;
  readonly issue?: SchemaIssueNode;
  readonly issues?: ReadonlyArray<SchemaIssueNode>;
}

interface ImportIssues {
  readonly invalidJson: boolean;
  readonly unexpected: readonly string[];
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

const noImportIssues: ImportIssues = {
  invalidJson: false,
  unexpected: [],
  missing: [],
  invalid: [],
};

const isSchemaIssue = (value: object): value is SchemaIssueNode =>
  "_tag" in value && typeof value._tag === "string";

const fieldName = (path: ReadonlyArray<PropertyKey>) =>
  path.map((segment) => (typeof segment === "number" ? `item ${segment + 1}` : String(segment))).join(" ");

const combineIssues = (left: ImportIssues, right: ImportIssues): ImportIssues => ({
  invalidJson: left.invalidJson || right.invalidJson,
  unexpected: [...left.unexpected, ...right.unexpected],
  missing: [...left.missing, ...right.missing],
  invalid: [...left.invalid, ...right.invalid],
});

const walkIssue = (issue: SchemaIssueNode, path: ReadonlyArray<PropertyKey>): ImportIssues => {
  if (issue._tag === "Pointer" && issue.path && issue.issue)
    return walkIssue(issue.issue, [...path, ...issue.path]);
  if (issue._tag === "UnexpectedKey") return { ...noImportIssues, unexpected: [fieldName(path)] };
  if (issue._tag === "MissingKey") return { ...noImportIssues, missing: [fieldName(path)] };
  if (issue._tag === "InvalidValue" || issue._tag === "InvalidType") {
    if (path.length === 0) return { ...noImportIssues, invalidJson: true };
    return { ...noImportIssues, invalid: [fieldName(path)] };
  }
  if (issue.issues)
    return issue.issues.reduce(
      (found, child) => combineIssues(found, walkIssue(child, path)),
      noImportIssues,
    );
  if (issue.issue) return walkIssue(issue.issue, path);
  return noImportIssues;
};

const listed = (fields: readonly string[]) => {
  const last = fields.at(-1);
  if (!last || fields.length === 1) return last ?? "";
  if (fields.length === 2) return `${fields[0]} and ${last}`;
  return `${fields.slice(0, -1).join(", ")}, and ${last}`;
};

const fieldSentence = (
  fields: readonly string[],
  one: (field: string) => string,
  many: (fields: readonly string[]) => string,
) => {
  const first = fields[0];
  if (!first) return [];
  return [fields.length === 1 ? one(first) : many(fields)];
};

const importFailureMessage = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("issue" in error) || typeof error.issue !== "object") {
    return "This file does not match a workflow.";
  }
  if (error.issue === null || !isSchemaIssue(error.issue)) return "This file does not match a workflow.";
  const found = walkIssue(error.issue, []);
  const sentences = [
    ...(found.invalidJson ? ["This file is not valid JSON."] : []),
    ...fieldSentence(
      found.unexpected,
      (field) => `Remove ${field}. A workflow file does not include that field.`,
      (fields) => `Remove ${listed(fields)}. A workflow file does not include those fields.`,
    ),
    ...fieldSentence(
      found.missing,
      (field) => `Add ${field} and try again.`,
      (fields) => `Add ${listed(fields)} and try again.`,
    ),
    ...fieldSentence(
      found.invalid,
      (field) => `${field} is not a value a workflow file accepts.`,
      (fields) => `${listed(fields)} are not values a workflow file accepts.`,
    ),
  ];
  return sentences.length > 0 ? sentences.join(" ") : "This file does not match a workflow.";
};

const decodeWorkflowJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkflowDocument = Schema.decodeUnknownEffect(WorkflowDocument, { onExcessProperty: "error" });
const encodeWorkflowJson = Schema.encodeSync(Schema.fromJsonString(WorkflowDocument, { space: 2 }));

// Windows and POSIX reject these characters in a file name. Control characters are dropped separately.
const reservedFileNameCharacter = /[<>:"/\\|?*]/g;

export class WorkflowImportError extends Data.TaggedError("WorkflowImportError")<{
  readonly message: string;
}> {}

const visibleFileName = (name: string) =>
  [...name].filter((character) => character.charCodeAt(0) >= 32).join("");

export const workflowExportFileName = (name: string) => {
  const cleaned = visibleFileName(name)
    .replace(reservedFileNameCharacter, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  const base = cleaned.length > 0 ? cleaned : "workflow";
  return base.toLowerCase().endsWith(".json") ? base : `${base}.json`;
};

export const exportWorkflow = (document: WorkflowDocument) => encodeWorkflowJson(document);

export const importWorkflow = (text: string) =>
  decodeWorkflowJson(text).pipe(
    Effect.flatMap(decodeWorkflowDocument),
    Effect.mapError((error) => new WorkflowImportError({ message: importFailureMessage(error) })),
  );
