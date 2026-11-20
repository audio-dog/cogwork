import { assert, describe, it } from "@effect/vitest";
import { applyWorkflowEdits, type WorkflowEditBatch } from "./workflow-edit";
import {
  baseDocument,
  codesOf,
  decodeCatalogKey,
  decodeDocument,
  decodeNodeId,
  operation,
  transition,
} from "./workflow-fixtures";
import { decodeWorkflowDocument } from "./workflow-validation";

describe("Workflow edits", () => {
  it("applies a batch in arrival order", () => {
    const result = applyWorkflowEdits(baseDocument, [
      { _tag: "Rename", name: "First" },
      { _tag: "Rename", name: "Second" },
    ]);

    assert.strictEqual(result._tag, "Ok");
    if (result._tag !== "Ok") return;
    assert.strictEqual(result.value.name, "Second");
  });

  it("refuses edits that exceed the answer-space bound", () => {
    const questions = Array.from({ length: 12 }, (_, index) => ({
      id: `question-${index}`,
      text: `Question ${index}`,
      choices: [
        { id: "yes", name: "Yes" },
        { id: "no", name: "No" },
      ],
    }));
    const targetQuestion = questions[0];
    if (!targetQuestion) throw new Error("missing target Question");
    const document = decodeDocument({
      ...baseDocument,
      operations: [{ ...operation, questions }],
    });
    const result = applyWorkflowEdits(document, [
      {
        _tag: "AddChoice",
        operation: operation.id,
        question: decodeNodeId(targetQuestion.id),
        choice: { id: decodeNodeId("maybe"), name: "Maybe" },
      },
    ]);

    assert.strictEqual(result._tag, "Refused");
    if (result._tag !== "Refused") return;
    assert.deepStrictEqual(
      result.diagnostics.map(({ code }) => code),
      ["schema"],
    );
    assert.lengthOf(document.operations[0]?.questions[0]?.choices ?? [], 2);
  });

  it("applies removal cascades before validating the final document", () => {
    const withNext = decodeDocument({
      ...baseDocument,
      triggers: [{ ...baseDocument.triggers[0], start: "next" }],
      operations: [
        { ...operation, transitions: [{ ...transition, handOff: "next" }] },
        { ...operation, id: "next" },
      ],
    });
    const result = applyWorkflowEdits(withNext, [
      { _tag: "RemoveOperation", operation: decodeNodeId("next") },
      { _tag: "RemoveTrigger", trigger: decodeNodeId("issue-opened") },
    ]);

    assert.strictEqual(result._tag, "Ok");
    if (result._tag !== "Ok") return;
    assert.isNull(result.value.operations[0]?.transitions[0]?.handOff);
    assert.notInclude(codesOf(result.value), "unknown-reference");
  });

  it("drops transitions that name a removed question or choice", () => {
    const document = decodeDocument({
      ...baseDocument,
      operations: [
        {
          ...operation,
          transitions: [
            {
              ...transition,
              when: [{ question: "decision", choice: "yes" }],
            },
          ],
        },
      ],
    });
    const edits = [
      [{ _tag: "RemoveQuestion", operation: operation.id, question: decodeNodeId("decision") }],
      [
        {
          _tag: "RemoveChoice",
          operation: operation.id,
          question: decodeNodeId("decision"),
          choice: decodeNodeId("yes"),
        },
      ],
    ] as const;

    edits.forEach((batch) => {
      const result = applyWorkflowEdits(document, batch);
      assert.strictEqual(result._tag, "Ok");
      if (result._tag !== "Ok") return;
      assert.isEmpty(result.value.operations[0]?.transitions ?? []);
    });
  });

  it("adds a Trigger filter once, removes it, and clears filters when the entry changes", () => {
    const trigger = decodeNodeId("issue-opened");
    const filter = { entry: decodeCatalogKey("github.issue-not-blocked") };
    const added = applyWorkflowEdits(baseDocument, [
      { _tag: "AddTriggerFilter", trigger, filter },
      { _tag: "AddTriggerFilter", trigger, filter },
    ]);
    assert.strictEqual(added._tag, "Ok");
    if (added._tag !== "Ok") return;
    const filtersAfter = (edit: WorkflowEditBatch[number]) => {
      const result = applyWorkflowEdits(added.value, [edit]);
      return result._tag === "Ok" ? result.value.triggers[0]?.filters : null;
    };

    assert.deepStrictEqual(baseDocument.triggers[0]?.filters, []);
    assert.deepStrictEqual(added.value.triggers[0]?.filters, [filter]);
    assert.deepStrictEqual(filtersAfter({ _tag: "RemoveTriggerFilter", trigger, entry: filter.entry }), []);
    assert.deepStrictEqual(
      filtersAfter({ _tag: "SetTriggerEntry", trigger, entry: decodeCatalogKey("github.issue-closed") }),
      [],
    );
  });

  it("decodes documents as data", () => {
    assert.strictEqual(decodeWorkflowDocument(baseDocument)._tag, "Ok");
    assert.strictEqual(decodeWorkflowDocument({ ...baseDocument, extra: true })._tag, "Refused");
  });
});
