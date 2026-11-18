import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  baseCatalog,
  catalogWith,
  decodeCatalogKey,
  decodeNodeId,
  decodeWorkspaceId,
  operation,
  replaceOperation,
  transition,
} from "./workflow-fixtures";
import {
  matchWorkflowTransitions,
  workflowOperationResultJsonSchema,
  workflowOperationResultSchema,
} from "./workflow-operation-result";

const jsonMember = (value: unknown, key: string) =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const cogworkWorkspace = decodeWorkspaceId("cogwork");

describe("Workflow Operation result", () => {
  const schema = workflowOperationResultSchema(operation, baseCatalog, [cogworkWorkspace]);
  const element = {
    summary: "Ready to continue",
    answers: { decision: decodeNodeId("yes") },
    inputs: { comment: "Proceed." },
    workspace: cogworkWorkspace,
  };

  it("decodes the flat result and refuses missing answers", () => {
    const decoded = Schema.decodeUnknownSync(schema)({
      summary: "Ready to continue",
      stuck: false,
      answers: { decision: decodeNodeId("yes") },
      inputs: { comment: "Proceed." },
      workspace: cogworkWorkspace,
    });

    if (!("answers" in decoded)) return assert.fail("expected a once result");
    assert.strictEqual(decoded.answers.decision, "yes");
    assert.throws(() =>
      Schema.decodeUnknownSync(schema)({
        summary: "Ready to continue",
        stuck: false,
        answers: {},
        inputs: { comment: "Proceed." },
        workspace: cogworkWorkspace,
      }),
    );
  });

  it("builds one strict object that requires a Workspace only when the agent chooses it", () => {
    const agentWorkspaceEntry = {
      ...baseCatalog.entries[1],
      key: decodeCatalogKey("github.create-issue"),
      workspaceSource: "agent" as const,
      agentInputs: [],
    };
    const mixedCatalog = catalogWith({ entries: [...baseCatalog.entries, agentWorkspaceEntry] });
    const mixedOperation = {
      ...operation,
      transitions: [
        {
          ...transition,
          actions: [...transition.actions, { entry: agentWorkspaceEntry.key, parameters: [] }],
        },
      ],
    };
    const resultFields = ["summary", "stuck", "answers", "inputs"];
    const cases = [
      { operation, catalog: baseCatalog, itemWorkspace: undefined, required: [...resultFields, "workspace"] },
      { operation, catalog: baseCatalog, itemWorkspace: cogworkWorkspace, required: resultFields },
      {
        operation: mixedOperation,
        catalog: mixedCatalog,
        itemWorkspace: cogworkWorkspace,
        required: [...resultFields, "workspace"],
      },
    ];

    cases.forEach((row) => {
      const json = workflowOperationResultJsonSchema(
        row.operation,
        row.catalog,
        [cogworkWorkspace],
        row.itemWorkspace,
      );
      assert.strictEqual(json.type, "object");
      assert.deepStrictEqual(json.required, row.required);
      assert.strictEqual(json.additionalProperties, false);
    });
  });

  describe("for an Operation with no questions and no agent inputs", () => {
    const noInputsEntry = { ...baseCatalog.entries[1], agentInputs: [] };
    const noInputsCatalog = catalogWith({ entries: [noInputsEntry] });
    const noQuestionsOperation = { ...operation, questions: [] };
    const emptyResult = { summary: "Commented", stuck: false, answers: {}, inputs: {} };
    const decodeEmpty = Schema.decodeUnknownExit(
      workflowOperationResultSchema(
        noQuestionsOperation,
        noInputsCatalog,
        [cogworkWorkspace],
        cogworkWorkspace,
      ),
    );
    const refusal = (result: unknown) => {
      const exit = decodeEmpty(result);
      return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "decoded";
    };

    it("decodes empty answers and inputs and refuses any key in them", () => {
      assert.isTrue(Exit.isSuccess(decodeEmpty(emptyResult)));
      assert.include(refusal({ ...emptyResult, answers: { decision: "yes" } }), 'at ["answers"]["decision"]');
      assert.include(
        refusal({ ...emptyResult, inputs: { comment: "Proceed." } }),
        'at ["inputs"]["comment"]',
      );
    });

    it("builds answers and inputs as strict empty objects", () => {
      const properties = jsonMember(
        workflowOperationResultJsonSchema(
          noQuestionsOperation,
          noInputsCatalog,
          [cogworkWorkspace],
          cogworkWorkspace,
        ),
        "properties",
      );
      const strictEmptyObject = { type: "object", additionalProperties: false };

      assert.deepStrictEqual(jsonMember(properties, "answers"), strictEmptyObject);
      assert.deepStrictEqual(jsonMember(properties, "inputs"), strictEmptyObject);
    });
  });

  it("builds review comments as one required list shape", () => {
    const reviewEntry = {
      ...baseCatalog.entries[1],
      key: decodeCatalogKey("github.post-review"),
      agentInputs: ["pull_request", "review_body", "review_comments"],
    };
    const reviewCatalog = { ...baseCatalog, entries: [reviewEntry] };
    const reviewOperation = {
      ...operation,
      transitions: [
        {
          ...transition,
          actions: [{ entry: reviewEntry.key, parameters: [] }],
        },
      ],
    };
    const json = workflowOperationResultJsonSchema(reviewOperation, reviewCatalog);
    const inputs = jsonMember(jsonMember(json, "properties"), "inputs");

    assert.isObject(inputs);
    if (typeof inputs !== "object" || inputs === null || !("properties" in inputs)) {
      return assert.fail("expected input properties");
    }
    assert.deepStrictEqual(jsonMember(inputs, "required"), [
      "pull_request",
      "review_body",
      "review_comments",
    ]);
    assert.deepStrictEqual(jsonMember(jsonMember(inputs, "properties"), "review_comments"), {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          body: { type: "string" },
        },
        required: ["path", "line", "body"],
        additionalProperties: false,
      },
    });
  });

  it("decodes at most 50 for-each elements", () => {
    const forEachSchema = workflowOperationResultSchema(
      { ...operation, forEach: "commitment" },
      baseCatalog,
      [cogworkWorkspace],
    );
    const decoded = Schema.decodeSync(forEachSchema)({
      summary: "Found commitments",
      stuck: false,
      elements: Array.from({ length: 50 }, () => element),
    });

    if (!("elements" in decoded)) return assert.fail("expected a for-each result");
    assert.lengthOf(decoded.elements, 50);
    assert.throws(() =>
      Schema.decodeSync(forEachSchema)({
        summary: "Found too many commitments",
        stuck: false,
        elements: Array.from({ length: 51 }, () => element),
      }),
    );
  });

  it("builds a strict for-each envelope", () => {
    const json = workflowOperationResultJsonSchema({ ...operation, forEach: "commitment" }, baseCatalog, [
      cogworkWorkspace,
    ]);

    assert.deepStrictEqual(json.required, ["summary", "stuck", "elements"]);
    assert.strictEqual(json.additionalProperties, false);
  });

  it("matches every Transition whose answers hold", () => {
    const document = replaceOperation({
      transitions: [
        { when: [], actions: [], handOff: null },
        {
          when: [{ question: decodeNodeId("decision"), choice: decodeNodeId("yes") }],
          actions: [{ entry: baseCatalog.entries[1]?.key ?? baseCatalog.entries[0]?.key, parameters: [] }],
          handOff: null,
        },
      ],
    });
    const target = document.operations[0];
    if (!target) return assert.fail("missing Operation");

    assert.lengthOf(matchWorkflowTransitions(target, { decision: "yes" }), 2);
    assert.lengthOf(matchWorkflowTransitions(target, { decision: "no" }), 1);
  });
});
