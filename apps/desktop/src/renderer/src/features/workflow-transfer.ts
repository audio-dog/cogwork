import { WorkflowDocument } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeWorkflowJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkflowDocument = Schema.decodeUnknownEffect(WorkflowDocument);
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
    Effect.mapError((error) => new WorkflowImportError({ message: error.message })),
  );
