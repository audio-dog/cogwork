import {
  MachineReadiness,
  PrincipalId,
  WorkflowCatalog,
  WorkflowDocument,
  WorkflowId,
  type WorkflowOption,
  type WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";

import { WorkflowEditor } from "../components/workflow-editor";
import { openTestWorkingCopies } from "../testing/working-copies";
import {
  type WorkflowClient,
  WorkflowProvider,
  type WorkflowSessionState,
  workflowProviderValue,
} from "./workflow-session";
import { type ListWorkflowOptions, WorkingCopiesProvider } from "./working-copy-provider";

export const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodePrincipalId = Schema.decodeUnknownSync(PrincipalId);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeMachine = Schema.decodeUnknownSync(MachineReadiness);

export const workflowDocument = decodeDocument({
  name: "Local name",
  workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("cogwork")] },
  triggers: [],
  operations: [],
});

export const record: WorkflowRecord = {
  id: decodeWorkflowId("workflow-1"),
  principal: decodePrincipalId("person"),
  workingCopy: workflowDocument,
  workingRevision: 1,
  publishedCopy: null,
  publishedRevision: null,
  enabled: false,
  diagnostics: [],
  readiness: [],
};

export const everyDocument = decodeDocument({
  name: "Every workspace",
  workspaces: { _tag: "Every" },
  triggers: [
    {
      id: "started",
      entry: "test.started",
      parameters: [{ id: "target", value: "" }],
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
      commands: { allow: [], deny: [] },
      connections: [],
      requires: [],
      model: { harness: "codex", model: "gpt-5", options: [] },
      forEach: null,
      questions: [{ id: "outcome", text: "Done?", choices: [{ id: "yes", name: "Yes" }] }],
      transitions: [
        {
          when: [{ question: "outcome", choice: "yes" }],
          actions: [{ entry: "test.done", parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

export const catalog = decodeCatalog({
  entries: [
    {
      key: "test.started",
      name: "Started",
      kind: "trigger",
      system: null,
      connection: null,
      requires: [],
      parameters: [{ id: "target", required: false, source: "live", values: [] }],
      itemKind: null,
      actsOn: [],
      requiresWorkspace: true,
      workspaceSource: null,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
    {
      key: "test.done",
      name: "Done",
      kind: "action",
      system: null,
      connection: null,
      requires: [],
      parameters: [{ id: "target", required: false, source: "live", values: [] }],
      itemKind: null,
      actsOn: [],
      requiresWorkspace: true,
      workspaceSource: "agent",
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
  ],
  instructionPackages: [],
  harnesses: [{ name: "codex", models: [{ id: "gpt-5", options: [] }] }],
});

const filterEntry = (key: string, name: string, system: string | null) => ({
  key,
  name,
  kind: "filter",
  system,
  connection: null,
  requires: [],
  parameters: [],
  itemKind: null,
  actsOn: [],
  requiresWorkspace: true,
  workspaceSource: null,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

export const filterCatalog = decodeCatalog({
  ...catalog,
  entries: [
    ...catalog.entries,
    filterEntry("test.unblocked", "Item is not blocked", null),
    filterEntry("github.issue-not-blocked", "Issue is not blocked", "github"),
  ],
});

export const machine = decodeMachine({
  workspaces: [
    { id: "first", binds: [] },
    { id: "second", binds: [] },
  ],
  connections: [],
  harnesses: [{ name: "codex", available: true }],
  defaultHarness: "codex",
  readyNeeds: [],
});

export const sessionState = (
  workflows: ReadonlyArray<WorkflowRecord>,
  overrides: Partial<WorkflowSessionState> = {},
): WorkflowSessionState => ({
  workflows,
  catalog: null,
  machine: null,
  workspaceLabels: new Map(),
  templates: [],
  harnesses: { catalogs: null, readiness: null, controlStore: null },
  needs: [],
  loading: false,
  ...overrides,
});

export const everyRecord: WorkflowRecord = {
  ...record,
  workingCopy: everyDocument,
  publishedCopy: everyDocument,
  publishedRevision: 1,
};

const transitionDocument = decodeDocument({
  ...everyDocument,
  operations: everyDocument.operations.map((operation) => ({
    ...operation,
    questions: [
      {
        id: "outcome",
        text: "Done?",
        choices: [
          { id: "yes", name: "Yes" },
          { id: "no", name: "No" },
        ],
      },
    ],
    transitions: [
      {
        when: [{ question: "outcome", choice: "yes" }],
        actions: [{ entry: "test.done", parameters: [{ id: "target", value: "first" }] }],
        handOff: null,
      },
      {
        when: [{ question: "outcome", choice: "no" }],
        actions: [{ entry: "test.done", parameters: [{ id: "target", value: "second" }] }],
        handOff: null,
      },
    ],
  })),
});

export const transitionRecord: WorkflowRecord = {
  ...everyRecord,
  workingCopy: transitionDocument,
  publishedCopy: transitionDocument,
};

export const unused = async () => {
  throw new Error("unexpected call");
};

export const sessionClient: WorkflowClient = { create: unused, switchEnabled: unused, delete: unused };

export const listFrom =
  (
    fake: (...args: Parameters<ListWorkflowOptions>) => Promise<ReadonlyArray<WorkflowOption>>,
  ): ListWorkflowOptions =>
  (...args) =>
    Effect.promise(() => fake(...args));

export const disposers: Array<() => Promise<void>> = [];

export const mountEditor = async (
  workflow: WorkflowRecord,
  {
    session = { catalog, machine },
    listOptions,
    importReview,
    onPublished,
  }: {
    readonly session?: Partial<WorkflowSessionState>;
    readonly listOptions?: ListWorkflowOptions;
    readonly importReview?: ReadonlyArray<string>;
    readonly onPublished?: () => void;
  } = {},
) => {
  const copies = await openTestWorkingCopies([workflow], listOptions);
  disposers.push(copies.dispose);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkflowProvider value={workflowProviderValue(sessionState([workflow], session), sessionClient)}>
        <WorkingCopiesProvider client={copies.client}>
          <WorkflowEditor workflow={workflow} importReview={importReview} onPublished={onPublished} />
        </WorkingCopiesProvider>
      </WorkflowProvider>,
    );
  });
  return { container, root, daemon: copies.daemon };
};

export const eventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(async () => {
    await act(() => Effect.runPromise(Effect.yieldNow));
    await assertion();
  });

export const typeInto = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

export const buttonNamed = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(({ textContent }) => textContent === text);

export const unmountEditors = async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
};
