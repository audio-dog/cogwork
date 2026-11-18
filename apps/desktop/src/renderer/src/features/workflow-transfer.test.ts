import { WorkflowDocument } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { exportWorkflow, importWorkflow } from "./workflow-transfer";

const document = Schema.decodeUnknownSync(WorkflowDocument)({
  name: "Ship the review",
  workspaces: { _tag: "Every" },
  triggers: [
    {
      id: "started",
      entry: "test.started",
      parameters: [],
      start: "work",
    },
  ],
  operations: [
    {
      id: "work",
      name: "Work",
      instructionPackage: null,
      instruction: "Do the work.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [],
      hints: [],
    },
  ],
});

const importedFailure = (text: string) =>
  Effect.runSync(
    importWorkflow(text).pipe(
      Effect.match({
        onFailure: (error) => error,
        onSuccess: () => {
          throw new Error("import succeeded");
        },
      }),
    ),
  );

describe("workflow transfer", () => {
  it("round-trips a workflow document without record fields", () => {
    const encoded = exportWorkflow(document);
    const parsed: unknown = JSON.parse(encoded);

    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("enabled");
    expect(parsed).not.toHaveProperty("publishedRevision");
    expect(parsed).not.toHaveProperty("diagnostics");
    expect(Effect.runSync(importWorkflow(encoded))).toEqual(document);
  });

  it("fails invalid JSON as a workflow import error", () => {
    const failure = importedFailure("{");

    expect(failure._tag).toBe("WorkflowImportError");
    expect(failure.message).toBe("This file is not valid JSON.");
  });

  it("fails a payload that adds a field the document schema rejects", () => {
    const payload: Record<string, unknown> = JSON.parse(exportWorkflow(document));
    payload.extra = "nope";
    const failure = importedFailure(JSON.stringify(payload));

    expect(failure._tag).toBe("WorkflowImportError");
    expect(failure.message).toBe("Remove extra. A workflow file does not include that field.");
  });

  it("names an unexpected field instead of the schema path", () => {
    const payload: Record<string, unknown> = JSON.parse(exportWorkflow(document));
    payload.description = "personal note";
    const failure = importedFailure(JSON.stringify(payload));

    expect(failure.message).toBe("Remove description. A workflow file does not include that field.");
    expect(failure.message).not.toContain("Expected no excess property");
  });

  it("asks for a field the file left out", () => {
    const failure = importedFailure(
      JSON.stringify({ workspaces: { _tag: "Every" }, triggers: [], operations: [] }),
    );

    expect(failure.message).toBe("Add name and try again.");
  });
});
