import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { HarnessName, WorkspaceId } from "./base-schemas";
import {
  adviseReadiness,
  applyWorkflowEdits,
  availabilityOf,
  decodeWorkflowDocument,
  MachineReadiness,
  NeedIdentity,
  validateWorkflow,
  validateWorkflowInput,
  type WorkflowCatalog,
  WorkflowCatalog as WorkflowCatalogSchema,
  type WorkflowDiagnosticCode,
  type WorkflowDocument,
  WorkflowDocument as WorkflowDocumentSchema,
  WorkflowEditBatch,
  WorkflowNodeId,
} from "./workflow";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocumentSchema);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalogSchema);
const decodeMachine = Schema.decodeUnknownSync(MachineReadiness);
const decodeHarness = Schema.decodeUnknownSync(HarnessName);
const decodeNeed = Schema.decodeUnknownSync(NeedIdentity);
const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeId);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);

const baseDocument = decodeDocument({
  name: "Issue helper",
  workspaces: { _tag: "Every" },
  triggers: [
    {
      id: "issue-opened",
      entry: "github.issue-opened",
      parameters: [{ id: "label", value: "ready" }],
      start: "triage",
    },
  ],
  operations: [
    {
      id: "triage",
      name: "Triage",
      instructionPackage: null,
      instruction: "Decide what to do.",
      permissionProfile: "full",
      requires: [],
      model: { harness: "codex", model: "gpt-5", options: [] },
      forEach: null,
      questions: [
        {
          id: "decision",
          text: "Proceed?",
          choices: [
            { id: "yes", name: "Yes" },
            { id: "no", name: "No" },
          ],
        },
      ],
      transitions: [
        {
          when: [],
          actions: [{ entry: "github.comment", parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

const baseCatalog = decodeCatalog({
  entries: [
    {
      key: "github.issue-opened",
      name: "Issue opened",
      kind: "trigger",
      system: "github",
      connection: "github/main",
      requires: [],
      parameters: [{ id: "label", required: true, source: "fixed", values: ["ready"] }],
      itemKind: "issue",
      actsOn: [],
      requiresWorkspace: true,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
    {
      key: "github.comment",
      name: "Comment",
      kind: "action",
      system: "github",
      connection: "github/main",
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: ["issue"],
      requiresWorkspace: true,
      permissionProfile: "full",
      agentInputs: ["comment"],
      emits: [],
    },
  ],
  instructionPackages: ["triage-agent"],
  harnesses: [
    {
      name: "codex",
      models: [{ id: "gpt-5", options: [] }],
    },
  ],
});

const baseMachine = decodeMachine({
  workspaces: [{ id: "cogwork", binds: ["github"] }],
  connections: [{ system: "github", ready: true, reason: null }],
  harnesses: [{ name: "codex", available: true }],
  defaultHarness: "codex",
  readyNeeds: ["tools"],
});

const operation = baseDocument.operations[0];
if (!operation) throw new Error("missing base Operation");
const transition = operation.transitions[0];
if (!transition) throw new Error("missing base Transition");

const documentWith = (change: Partial<WorkflowDocument>) => decodeDocument({ ...baseDocument, ...change });
const catalogWith = (change: Partial<WorkflowCatalog>) => decodeCatalog({ ...baseCatalog, ...change });
const machineWith = (change: Partial<typeof baseMachine>) => decodeMachine({ ...baseMachine, ...change });
const replaceOperation = (change: Partial<(typeof baseDocument.operations)[number]>) =>
  documentWith({ operations: [{ ...operation, ...change }] });

const codesOf = (document = baseDocument, catalog = baseCatalog) =>
  validateWorkflow(document, catalog).map(({ code }) => code);

const readinessCodesOf = (document = baseDocument, catalog = baseCatalog, machine = baseMachine) =>
  adviseReadiness(document, catalog, machine).map(({ code }) => code);

interface DiagnosticCase {
  readonly code: WorkflowDiagnosticCode;
  readonly produce: () => ReadonlyArray<WorkflowDiagnosticCode>;
}

const diagnosticCases: ReadonlyArray<DiagnosticCase> = [
  {
    code: "schema",
    produce: () =>
      validateWorkflowInput({ ...baseDocument, extra: true }, baseCatalog).map(({ code }) => code),
  },
  {
    code: "unknown-target",
    produce: () => {
      const result = applyWorkflowEdits(baseDocument, [
        { _tag: "RemoveOperation", operation: decodeNodeId("missing") },
      ]);
      return result._tag === "Refused" ? result.diagnostics.map(({ code }) => code) : [];
    },
  },
  {
    code: "duplicate-id",
    produce: () => codesOf(documentWith({ operations: [operation, operation] })),
  },
  {
    code: "duplicate-transition",
    produce: () => codesOf(replaceOperation({ transitions: [transition, transition] })),
  },
  {
    code: "unknown-reference",
    produce: () =>
      codesOf(
        replaceOperation({
          transitions: [{ ...transition, when: [{ question: operation.id, choice: operation.id }] }],
        }),
      ),
  },
  {
    code: "self-hand-off",
    produce: () => codesOf(replaceOperation({ transitions: [{ ...transition, handOff: operation.id }] })),
  },
  {
    code: "unknown-catalog-entry",
    produce: () =>
      codesOf(
        documentWith({
          triggers: [{ ...baseDocument.triggers[0], entry: baseCatalog.entries[1]?.key }],
        }),
      ),
  },
  {
    code: "unknown-option",
    produce: () =>
      codesOf(
        documentWith({
          triggers: [
            {
              ...baseDocument.triggers[0],
              parameters: [{ id: "unexpected", value: "value" }],
            },
          ],
        }),
      ),
  },
  {
    code: "unknown-model",
    produce: () =>
      codesOf(replaceOperation({ model: { harness: decodeHarness("missing"), model: null, options: [] } })),
  },
  { code: "no-trigger", produce: () => codesOf(documentWith({ triggers: [] })) },
  {
    code: "uncovered-outcome",
    produce: () => codesOf(replaceOperation({ transitions: [] })),
  },
  {
    code: "conflicting-hand-offs",
    produce: () => {
      const next = decodeDocument({
        ...baseDocument,
        operations: [operation, { ...operation, id: "next" }, { ...operation, id: "other" }],
      });
      const first = next.operations[0];
      if (!first) return [];
      return codesOf(
        decodeDocument({
          ...next,
          operations: [
            {
              ...first,
              transitions: [
                { ...transition, handOff: "next" },
                { ...transition, when: [{ question: "decision", choice: "yes" }], handOff: "other" },
              ],
            },
            ...next.operations.slice(1),
          ],
        }),
      );
    },
  },
  {
    code: "empty-instruction",
    produce: () => codesOf(replaceOperation({ instruction: "", instructionPackage: null })),
  },
  {
    code: "missing-option",
    produce: () => codesOf(documentWith({ triggers: [{ ...baseDocument.triggers[0], parameters: [] }] })),
  },
  {
    code: "profile-too-narrow",
    produce: () => codesOf(replaceOperation({ permissionProfile: "read-only" })),
  },
  {
    code: "no-workspace",
    produce: () => codesOf(documentWith({ workspaces: { _tag: "Listed", workspaces: [] } })),
  },
  {
    code: "item-kind-mismatch",
    produce: () =>
      codesOf(
        baseDocument,
        catalogWith({
          entries: baseCatalog.entries.map((entry) =>
            entry.kind === "action" ? { ...entry, actsOn: ["pull-request"] } : entry,
          ),
        }),
      ),
  },
  {
    code: "connection-not-ready",
    produce: () => readinessCodesOf(baseDocument, baseCatalog, machineWith({ connections: [] })),
  },
  {
    code: "need-not-ready",
    produce: () => readinessCodesOf(replaceOperation({ requires: [decodeNeed("missing")] })),
  },
  {
    code: "harness-unavailable",
    produce: () =>
      readinessCodesOf(
        baseDocument,
        baseCatalog,
        machineWith({ harnesses: [{ name: decodeHarness("codex"), available: false }] }),
      ),
  },
  {
    code: "no-harness",
    produce: () =>
      readinessCodesOf(
        replaceOperation({ model: { harness: null, model: null, options: [] } }),
        baseCatalog,
        machineWith({ defaultHarness: null }),
      ),
  },
  {
    code: "workspace-not-registered",
    produce: () =>
      readinessCodesOf(
        documentWith({ workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("missing")] } }),
      ),
  },
  {
    code: "system-unbound",
    produce: () => readinessCodesOf(baseDocument, baseCatalog, machineWith({ workspaces: [] })),
  },
  {
    code: "unreachable-operation",
    produce: () =>
      codesOf(
        documentWith({
          operations: [
            operation,
            decodeDocument({ ...baseDocument, operations: [{ ...operation, id: "other" }] }).operations[0],
          ],
        }),
      ),
  },
  {
    code: "option-not-listed",
    produce: () => {
      const entries = decodeCatalog({
        ...baseCatalog,
        entries: baseCatalog.entries.map((entry) =>
          entry.kind === "trigger"
            ? {
                ...entry,
                parameters: [{ id: "label", required: true, source: "live", values: [] }],
              }
            : entry,
        ),
      }).entries;
      return readinessCodesOf(baseDocument, catalogWith({ entries }));
    },
  },
  {
    code: "hand-off-and-trigger",
    produce: () => {
      const next = decodeDocument({ ...baseDocument, operations: [operation, { ...operation, id: "next" }] });
      const entries = baseCatalog.entries.map((entry) =>
        entry.kind === "action" ? { ...entry, emits: [baseDocument.triggers[0]?.entry] } : entry,
      );
      return codesOf(
        decodeDocument({
          ...next,
          triggers: [
            { ...baseDocument.triggers[0], start: "next" },
            { ...baseDocument.triggers[0], id: "same-entry", start: "triage" },
          ],
          operations: [
            { ...operation, transitions: [{ ...transition, handOff: "next" }] },
            ...next.operations.slice(1),
          ],
        }),
        catalogWith({ entries }),
      );
    },
  },
];

describe("Workflow validator", () => {
  it("rejects excess document keys at the Schema boundary", () => {
    assert.isFalse(Schema.is(WorkflowDocumentSchema)({ ...baseDocument, extra: true }));
  });

  it("bounds the answer combinations expanded by validation", () => {
    const questions = Array.from({ length: 13 }, (_, index) => ({
      id: `question-${index}`,
      text: `Question ${index}`,
      choices: [
        { id: "yes", name: "Yes" },
        { id: "no", name: "No" },
      ],
    }));
    const document = {
      ...baseDocument,
      operations: [{ ...operation, questions }],
    };

    assert.isFalse(Schema.is(WorkflowDocumentSchema)(document));
  });

  it("does not produce a section 5 code for the complete worked document", () => {
    assert.deepStrictEqual(validateWorkflow(baseDocument, baseCatalog), []);
    assert.deepStrictEqual(adviseReadiness(baseDocument, baseCatalog, baseMachine), []);
  });

  it("keeps machine advisories out of document validation", () => {
    const machine = machineWith({ connections: [], workspaces: [], harnesses: [], readyNeeds: [] });

    assert.deepStrictEqual(validateWorkflow(baseDocument, baseCatalog), []);
    assert.isAbove(adviseReadiness(baseDocument, baseCatalog, machine).length, 0);
  });

  it("reports catalog entry availability from machine state", () => {
    const entry = baseCatalog.entries[0];
    if (!entry) throw new Error("missing test Catalog entry");
    const unavailable = machineWith({
      connections: [{ system: "github", ready: false, reason: "Token expired" }],
    });

    assert.strictEqual(availabilityOf(entry, baseMachine)._tag, "Available");
    assert.strictEqual(availabilityOf(entry, machineWith({ connections: [] }))._tag, "ConnectionNeeded");
    assert.deepStrictEqual(availabilityOf(entry, unavailable), {
      _tag: "Unavailable",
      reason: "Token expired",
    });
  });

  it("requires node ids to be unique across the document", () => {
    const documents = [
      documentWith({ triggers: [{ ...baseDocument.triggers[0], id: operation.id }] }),
      documentWith({ operations: [operation, { ...operation, id: decodeNodeId("next") }] }),
    ];

    documents.forEach((document) => {
      assert.include(codesOf(document), "duplicate-id");
    });
  });

  it("produces every section 5 code", () => {
    diagnosticCases.forEach((testCase) => {
      assert.include(testCase.produce(), testCase.code);
    });
  });
});

describe("Workflow edits", () => {
  it("rejects excess edit keys at the Schema boundary", () => {
    assert.isFalse(Schema.is(WorkflowEditBatch)([{ _tag: "Rename", name: "Edited", extra: true }]));
    assert.isFalse(Schema.is(WorkflowEditBatch)([{ _tag: "ReplaceOperation", id: "triage", operation }]));
  });

  it("applies a batch in arrival order", () => {
    const result = applyWorkflowEdits(baseDocument, [
      { _tag: "Rename", name: "First" },
      { _tag: "Rename", name: "Second" },
    ]);

    assert.strictEqual(result._tag, "Ok");
    if (result._tag !== "Ok") return;
    assert.strictEqual(result.value.name, "Second");
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

  it("decodes documents as data", () => {
    assert.strictEqual(decodeWorkflowDocument(baseDocument)._tag, "Ok");
    assert.strictEqual(decodeWorkflowDocument({ ...baseDocument, extra: true })._tag, "Refused");
  });
});
