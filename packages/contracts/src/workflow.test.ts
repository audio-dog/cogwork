import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkspaceId } from "./base-schemas";
import {
  applyWorkflowEdits,
  validateWorkflow,
  validateWorkflowInput,
  type WorkflowCatalog,
  WorkflowCatalog as WorkflowCatalogSchema,
  type WorkflowDiagnosticCode,
  type WorkflowDocument,
  WorkflowDocument as WorkflowDocumentSchema,
  WorkflowNodeId,
} from "./workflow";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocumentSchema);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalogSchema);
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
  models: [
    {
      harness: "codex",
      available: true,
      models: [{ id: "gpt-5", options: [] }],
    },
  ],
  defaultHarness: "codex",
  registeredWorkspaces: ["cogwork"],
  systemBindings: [{ system: "github", workspaces: ["cogwork"] }],
  readyConnections: ["github/main"],
  readyNeeds: ["tools"],
});

const operation = baseDocument.operations[0];
if (!operation) throw new Error("missing base Operation");
const transition = operation.transitions[0];
if (!transition) throw new Error("missing base Transition");

const documentWith = (change: Partial<WorkflowDocument>) => decodeDocument({ ...baseDocument, ...change });
const catalogWith = (change: Partial<WorkflowCatalog>) => decodeCatalog({ ...baseCatalog, ...change });
const replaceOperation = (change: Partial<(typeof baseDocument.operations)[number]>) =>
  documentWith({ operations: [{ ...operation, ...change }] });

const codesOf = (document = baseDocument, catalog = baseCatalog) =>
  validateWorkflow(document, catalog).map(({ code }) => code);

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
        { _tag: "RemoveOperation", id: decodeNodeId("missing") },
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
              parameters: [{ id: "label", value: "missing" }],
            },
          ],
        }),
      ),
  },
  {
    code: "unknown-model",
    produce: () => codesOf(replaceOperation({ model: { ...operation.model, model: "missing" } })),
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
    produce: () => codesOf(baseDocument, catalogWith({ readyConnections: [] })),
  },
  {
    code: "need-not-ready",
    produce: () => codesOf(replaceOperation({ requires: ["missing"] })),
  },
  {
    code: "harness-unavailable",
    produce: () =>
      codesOf(baseDocument, catalogWith({ models: [{ ...baseCatalog.models[0], available: false }] })),
  },
  {
    code: "no-harness",
    produce: () =>
      codesOf(
        replaceOperation({ model: { harness: null, model: null, options: [] } }),
        catalogWith({ defaultHarness: null }),
      ),
  },
  {
    code: "workspace-not-registered",
    produce: () =>
      codesOf(documentWith({ workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("missing")] } })),
  },
  {
    code: "system-unbound",
    produce: () => codesOf(baseDocument, catalogWith({ systemBindings: [] })),
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
      return codesOf(baseDocument, catalogWith({ entries }));
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
          triggers: [{ ...baseDocument.triggers[0], start: "next" }],
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
  it("does not produce a section 5 code for the complete worked document", () => {
    assert.deepStrictEqual(validateWorkflow(baseDocument, baseCatalog), []);
  });

  it("produces every section 5 code", () => {
    diagnosticCases.forEach((testCase) => {
      assert.include(testCase.produce(), testCase.code);
    });
  });
});

describe("Workflow edits", () => {
  it("applies a batch in arrival order", () => {
    const result = applyWorkflowEdits(baseDocument, [
      { _tag: "SetName", name: "First" },
      { _tag: "SetName", name: "Second" },
    ]);

    assert.strictEqual(result._tag, "Applied");
    if (result._tag !== "Applied") return;
    assert.strictEqual(result.document.name, "Second");
  });
});
