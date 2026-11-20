import * as Schema from "effect/Schema";

import { WorkspaceId } from "./base-schemas";
import {
  WorkflowCatalogKey,
  type WorkflowDocument,
  WorkflowDocument as WorkflowDocumentSchema,
  WorkflowNodeId,
} from "./workflow";
import {
  MachineReadiness,
  type WorkflowCatalog,
  WorkflowCatalog as WorkflowCatalogSchema,
} from "./workflow-catalog";
import { validateWorkflow } from "./workflow-validation";

export const decodeDocument = Schema.decodeUnknownSync(WorkflowDocumentSchema);
export const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalogSchema);
export const decodeMachine = Schema.decodeUnknownSync(MachineReadiness);
export const decodeNodeId = Schema.decodeUnknownSync(WorkflowNodeId);
export const decodeCatalogKey = Schema.decodeUnknownSync(WorkflowCatalogKey);
export const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
export const baseDocument = decodeDocument({
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

export const baseCatalog = decodeCatalog({
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
      workspaceSource: null,
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
      workspaceSource: "item-else-agent",
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

export const baseMachine = decodeMachine({
  workspaces: [{ id: "cogwork", binds: ["github"] }],
  connections: [{ system: "github", ready: true, reason: null }],
  harnesses: [{ name: "codex", available: true }],
  defaultHarness: "codex",
  readyNeeds: ["tools"],
});

export const operation = baseDocument.operations[0];
if (!operation) throw new Error("missing base Operation");
export const transition = operation.transitions[0];
if (!transition) throw new Error("missing base Transition");

export const documentWith = (change: Partial<WorkflowDocument>) =>
  decodeDocument({ ...baseDocument, ...change });
export const catalogWith = (change: Partial<WorkflowCatalog>) => decodeCatalog({ ...baseCatalog, ...change });

export const replaceOperation = (change: Partial<(typeof baseDocument.operations)[number]>) =>
  documentWith({ operations: [{ ...operation, ...change }] });

export const codesOf = (document = baseDocument, catalog = baseCatalog) =>
  validateWorkflow(document, catalog).map(({ code }) => code);
