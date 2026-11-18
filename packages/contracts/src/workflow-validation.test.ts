import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { HarnessName } from "./base-schemas";
import { NeedIdentity, type WorkflowDocument, WorkflowDocument as WorkflowDocumentSchema } from "./workflow";
import type { WorkflowDiagnosticCode } from "./workflow-diagnostic";
import { applyWorkflowEdits } from "./workflow-edit";
import {
  baseCatalog,
  baseDocument,
  baseMachine,
  catalogWith,
  codesOf,
  decodeCatalog,
  decodeCatalogKey,
  decodeDocument,
  decodeMachine,
  decodeNodeId,
  decodeWorkspaceId,
  documentWith,
  operation,
  replaceOperation,
  transition,
} from "./workflow-fixtures";
import { adviseReadiness, availabilityOf } from "./workflow-readiness";
import { validateWorkflow, validateWorkflowInput } from "./workflow-validation";

const decodeHarness = Schema.decodeUnknownSync(HarnessName);

const decodeNeed = Schema.decodeUnknownSync(NeedIdentity);

const filterEntry = (system: string, itemKind: string) => ({
  key: `${system}.${itemKind}-not-blocked`,
  name: "Not blocked",
  kind: "filter",
  system,
  connection: system,
  requires: [],
  parameters: [],
  itemKind,
  actsOn: [],
  requiresWorkspace: true,
  workspaceSource: null,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

const filterCatalog = decodeCatalog({
  ...baseCatalog,
  entries: [
    ...baseCatalog.entries,
    filterEntry("github", "issue"),
    filterEntry("linear", "issue"),
    filterEntry("github", "pull-request"),
  ],
});

const filteredDocument = (entry: string) =>
  documentWith({
    triggers: [{ ...baseDocument.triggers[0], filters: [{ entry: decodeCatalogKey(entry) }] }],
  });

const machineWith = (change: Partial<typeof baseMachine>) => decodeMachine({ ...baseMachine, ...change });

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
              parameters: [
                { id: "label", value: "missing" },
                { id: "label", value: "ready" },
              ],
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
    produce: () =>
      codesOf(
        replaceOperation({
          questions: [{ ...operation.questions[0], choices: [] }],
        }),
      ),
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
                parameters: [{ id: "label", required: true, source: "live", values: ["ready"] }],
              }
            : entry,
        ),
      }).entries;
      return readinessCodesOf(
        documentWith({
          triggers: [
            {
              ...baseDocument.triggers[0],
              parameters: [
                { id: "label", value: "missing" },
                { id: "label", value: "ready" },
              ],
            },
          ],
        }),
        catalogWith({ entries }),
      );
    },
  },
  {
    code: "filter-not-applicable",
    produce: () => codesOf(filteredDocument("linear.issue-not-blocked"), filterCatalog),
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

  it("accepts a listed instruction package without an inline instruction", () => {
    const diagnostics = validateWorkflow(
      replaceOperation({ instructionPackage: "triage-agent", instruction: "" }),
      baseCatalog,
    );

    assert.notInclude(
      diagnostics.map(({ code }) => code),
      "empty-instruction",
    );
  });

  it("reports an unknown instruction package as an unknown catalog entry", () => {
    const diagnostics = validateWorkflow(
      replaceOperation({ instructionPackage: "missing-agent" }),
      baseCatalog,
    );

    assert.deepStrictEqual(
      diagnostics.map(({ code }) => code),
      ["unknown-catalog-entry"],
    );
  });

  it("keeps machine advisories out of document validation", () => {
    const machine = machineWith({ connections: [], workspaces: [], harnesses: [], readyNeeds: [] });

    assert.deepStrictEqual(validateWorkflow(baseDocument, baseCatalog), []);
    assert.isAbove(adviseReadiness(baseDocument, baseCatalog, machine).length, 0);
  });

  it("does not advise on a live value when the catalog lists no values for its parameter", () => {
    const entries = decodeCatalog({
      ...baseCatalog,
      entries: baseCatalog.entries.map((entry) =>
        entry.kind === "trigger"
          ? { ...entry, parameters: [{ id: "label", required: true, source: "live", values: [] }] }
          : entry,
      ),
    }).entries;
    const document = documentWith({
      triggers: [{ ...baseDocument.triggers[0], parameters: [{ id: "label", value: "needs-triage" }] }],
    });

    assert.notInclude(readinessCodesOf(document, catalogWith({ entries })), "option-not-listed");
  });

  it("reports how many selected Workspaces bind a Trigger app", () => {
    const second = decodeWorkspaceId("second");
    const document = documentWith({
      workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("cogwork"), second] },
    });
    const readiness = adviseReadiness(
      document,
      baseCatalog,
      machineWith({ workspaces: [...baseMachine.workspaces, { id: second, binds: [] }] }),
    );

    assert.include(
      readiness.map(({ message }) => message),
      "github.issue-opened observes in 1 of 2 Workspaces",
    );
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

  it("accepts a filter from the Trigger's app and item kind", () => {
    assert.isEmpty(codesOf(filteredDocument("github.issue-not-blocked"), filterCatalog));
  });

  it.each([
    { case: "another app", entry: "linear.issue-not-blocked", code: "filter-not-applicable" },
    { case: "another item kind", entry: "github.pull-request-not-blocked", code: "filter-not-applicable" },
    { case: "no catalog entry", entry: "github.issue-missing", code: "unknown-catalog-entry" },
    { case: "a Trigger entry", entry: "github.issue-opened", code: "unknown-catalog-entry" },
  ])("reports a Trigger filter from $case", ({ entry, code }) => {
    assert.deepStrictEqual(codesOf(filteredDocument(entry), filterCatalog), [code]);
  });

  const [issueTrigger, issueAction] = baseCatalog.entries;
  const appAction = (key: string, actsOn: ReadonlyArray<string>) => ({
    ...issueAction,
    key,
    system: key.split(".", 1)[0],
    actsOn,
  });
  const appCatalog = decodeCatalog({
    ...baseCatalog,
    entries: [
      ...baseCatalog.entries,
      { ...issueTrigger, key: "linear.issue-opened", system: "linear", connection: "linear/main" },
      { ...issueTrigger, key: "schedule.sweep", system: null, connection: null },
      appAction("github.add-label", ["github.issue"]),
      appAction("github.open-pull-request", ["issue"]),
    ],
  });
  const itemKindMessages = (document: WorkflowDocument) =>
    validateWorkflow(document, appCatalog)
      .filter(({ code }) => code === "item-kind-mismatch")
      .map(({ message }) => message);
  const startedBy = (trigger: string, action: string) =>
    documentWith({
      triggers: [{ ...baseDocument.triggers[0], entry: decodeCatalogKey(trigger) }],
      operations: [
        {
          ...operation,
          transitions: [{ ...transition, actions: [{ entry: decodeCatalogKey(action), parameters: [] }] }],
        },
      ],
    });

  it.each([
    {
      case: "a github action reached by a linear issue",
      trigger: "linear.issue-opened",
      action: "github.add-label",
      messages: [
        "Action github.add-label in Operation triage acts only on github.issue, but linear.issue reaches it",
      ],
    },
    {
      case: "a github action reached by a github issue",
      trigger: "github.issue-opened",
      action: "github.add-label",
      messages: [],
    },
    {
      case: "an action of any app's issue reached by a linear issue",
      trigger: "linear.issue-opened",
      action: "github.open-pull-request",
      messages: [],
    },
    {
      case: "a github action reached by an issue of no named app",
      trigger: "schedule.sweep",
      action: "github.add-label",
      messages: [],
    },
  ])("matches the item app for $case", ({ trigger, action, messages }) => {
    assert.deepStrictEqual(itemKindMessages(startedBy(trigger, action)), messages);
  });

  it("carries the item app through a hand-off", () => {
    const review = decodeNodeId("review");
    const document = documentWith({
      triggers: [{ ...baseDocument.triggers[0], entry: decodeCatalogKey("linear.issue-opened") }],
      operations: [
        { ...operation, transitions: [{ ...transition, handOff: review }] },
        {
          ...operation,
          id: review,
          transitions: [
            {
              ...transition,
              actions: [{ entry: decodeCatalogKey("github.add-label"), parameters: [] }],
            },
          ],
        },
      ],
    });

    assert.deepStrictEqual(itemKindMessages(document), [
      "Action github.add-label in Operation review acts only on github.issue, but linear.issue reaches it",
    ]);
  });

  it("produces every section 5 code", () => {
    diagnosticCases.forEach((testCase) => {
      assert.include(testCase.produce(), testCase.code);
    });
  });
});
