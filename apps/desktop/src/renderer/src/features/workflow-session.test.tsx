// @vitest-environment happy-dom

import {
  applyWorkflowEdits,
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
import { act, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "../components/workflow-editor";
import { WorkflowsList } from "../components/workflows-list";
import {
  type WorkflowClient,
  WorkflowProvider,
  type WorkflowSessionState,
  workflowProviderValue,
} from "./workflow-session";
import { importWorkflow } from "./workflow-transfer";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const navigate = vi.hoisted(() => vi.fn(async (_destination: unknown) => undefined));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
    onClick,
    onKeyDown,
    "aria-label": ariaLabel,
  }: {
    readonly children?: ReactNode;
    readonly to?: string;
    readonly params?: { readonly workflowId?: string };
    readonly onClick?: (event: { readonly defaultPrevented: boolean }) => void;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
    readonly "aria-label"?: string;
  }) => (
    <a
      href={to ?? "/workflows"}
      aria-label={ariaLabel}
      onClick={async (event) => {
        onClick?.(event);
        if (event.defaultPrevented || to !== "/workflows/$workflowId" || !params?.workflowId) return;
        await navigate({ to, params: { workflowId: params.workflowId } });
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodePrincipalId = Schema.decodeUnknownSync(PrincipalId);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeMachine = Schema.decodeUnknownSync(MachineReadiness);

const workflowDocument = decodeDocument({
  name: "Local name",
  workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("cogwork")] },
  triggers: [],
  operations: [],
});

const record: WorkflowRecord = {
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

const everyDocument = decodeDocument({
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

const catalog = decodeCatalog({
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

const filterCatalog = decodeCatalog({
  ...catalog,
  entries: [
    ...catalog.entries,
    filterEntry("test.unblocked", "Item is not blocked", null),
    filterEntry("github.issue-not-blocked", "Issue is not blocked", "github"),
  ],
});

const machine = decodeMachine({
  workspaces: [
    { id: "first", binds: [] },
    { id: "second", binds: [] },
  ],
  connections: [],
  harnesses: [{ name: "codex", available: true }],
  defaultHarness: "codex",
  readyNeeds: [],
});

const sessionState = (
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

const everyRecord: WorkflowRecord = {
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

const transitionRecord: WorkflowRecord = {
  ...everyRecord,
  workingCopy: transitionDocument,
  publishedCopy: transitionDocument,
};

const unused = async () => {
  throw new Error("unexpected call");
};

const mountEditor = async (
  workflow: WorkflowRecord,
  client: WorkflowClient,
  editorCatalog: WorkflowCatalog = catalog,
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (current: WorkflowRecord) =>
    act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([current], { catalog: editorCatalog, machine }), client)}
        >
          <WorkflowEditor workflow={current} />
        </WorkflowProvider>,
      );
    });
  await render(workflow);
  return { container, render, root };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("WorkflowProvider", () => {
  it("sends one tagged edit on blur and renders the daemon value", async () => {
    const edit = vi.fn<WorkflowClient["edit"]>(async (_id, edits) => ({
      ...record,
      workingCopy: {
        ...workflowDocument,
        name: edits[0]._tag === "Rename" ? "Daemon name" : workflowDocument.name,
      },
      workingRevision: 2,
    }));
    const client: WorkflowClient = {
      create: unused,
      edit,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), client)}>
          <WorkflowEditor workflow={record} />
        </WorkflowProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");

    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Typed name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      await Promise.resolve();
    });

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(record.id, [{ _tag: "Rename", name: "Typed name" }]);
    expect(input.value).toBe("Daemon name");
    await act(async () => root.unmount());
  });

  it("keeps the typed outcome name through a pause and shows the saved name on blur", async () => {
    vi.useFakeTimers();
    const pause = () => vi.advanceTimersByTimeAsync(600);
    const current = { record: everyRecord };
    const edit = vi.fn<WorkflowClient["edit"]>(async (_id, edits) => {
      const applied = applyWorkflowEdits(current.record.workingCopy, edits);
      if (applied._tag === "Refused") throw new Error("refused");
      current.record = {
        ...current.record,
        workingCopy: applied.value,
        workingRevision: current.record.workingRevision + 1,
      };
      return current.record;
    });
    const client: WorkflowClient = {
      create: unused,
      edit,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const { container, root } = await mountEditor(everyRecord, client);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Outcome 1"]');
    if (!input) throw new Error("Outcome name input did not render");
    const type = (text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });

    input.focus();
    await type("");
    await act(pause);
    expect(input.value).toBe("");
    await type("ready ");
    await act(pause);
    expect(edit).toHaveBeenCalledOnce();
    expect(input.value).toBe("ready ");
    await type("ready for agent ");
    await act(async () => input.blur());

    expect(input.value).toBe("ready for agent");
    expect(current.record.workingCopy.operations[0]?.questions[0]?.choices[0]?.name).toBe("ready for agent");
    await act(async () => root.unmount());
  });

  it("removes the only question so the Operation has no outcomes to answer", async () => {
    const edit = vi.fn<WorkflowClient["edit"]>(async (_id, edits) => {
      const applied = applyWorkflowEdits(everyRecord.workingCopy, edits);
      if (applied._tag === "Refused") throw new Error("refused");
      return { ...everyRecord, workingCopy: applied.value, workingRevision: 2 };
    });
    const client: WorkflowClient = {
      create: unused,
      edit,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const { container, render, root } = await mountEditor(everyRecord, client);
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove question 1"]');
    if (!remove) throw new Error("The only question has no remove control");

    await act(async () => remove.click());
    const saved = await edit.mock.results[0]?.value;
    await render(saved);

    expect(edit).toHaveBeenCalledWith(everyRecord.id, [
      { _tag: "RemoveQuestion", operation: "work", question: "outcome" },
    ]);
    expect(container.querySelector('input[aria-label="Question 1"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("adds a Trigger filter from the filters that apply, and removes it", async () => {
    const current = { record: everyRecord };
    const edit = vi.fn<WorkflowClient["edit"]>(async (_id, edits) => {
      const applied = applyWorkflowEdits(current.record.workingCopy, edits);
      if (applied._tag === "Refused") throw new Error("refused");
      current.record = { ...current.record, workingCopy: applied.value };
      return current.record;
    });
    const client: WorkflowClient = {
      create: unused,
      edit,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const { container, render, root } = await mountEditor(everyRecord, client, filterCatalog);
    const addFilter = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Add filter",
    );
    if (!addFilter) throw new Error("Add filter did not render");
    const menuItem = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        ({ textContent }) => textContent === text,
      );

    await act(async () => addFilter.click());
    expect(menuItem("Issue is not blocked")).toBeUndefined();
    await act(async () => menuItem("Item is not blocked")?.click());
    await render(current.record);
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove filter Item is not blocked"]',
    );
    if (!remove) throw new Error("The added filter did not render");
    await act(async () => remove.click());

    expect(edit.mock.calls.map(([, edits]) => edits)).toEqual([
      [{ _tag: "AddTriggerFilter", trigger: "started", filter: { entry: "test.unblocked" } }],
      [{ _tag: "RemoveTriggerFilter", trigger: "started", entry: "test.unblocked" }],
    ]);
    await act(async () => root.unmount());
  });

  it("saves a draft before the switch turns it on", async () => {
    const live = { ...record, workingRevision: 3 };
    const publish = vi.fn<WorkflowClient["publish"]>(async () => ({ ...live, publishedRevision: 3 }));
    const switchEnabled = vi.fn<WorkflowClient["switchEnabled"]>(async () => ({
      ...live,
      publishedRevision: 3,
      enabled: true,
    }));
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish,
      switchEnabled,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderEditor = (workflow: WorkflowRecord) => (
      <WorkflowProvider value={workflowProviderValue(sessionState([workflow]), client)}>
        <WorkflowEditor workflow={workflow} />
      </WorkflowProvider>
    );
    await act(async () => root.render(renderEditor(record)));
    await act(async () => root.render(renderEditor(live)));
    const enable = container.querySelector<HTMLElement>('[aria-label="Turn this Workflow on"]');
    if (!enable) throw new Error("Switch did not render");

    await act(async () => {
      enable.click();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledWith(record.id, 3);
    expect(switchEnabled).toHaveBeenCalledWith(record.id, true);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(switchEnabled.mock.invocationCallOrder[0] ?? 0);
    await act(async () => root.unmount());
  });

  it("previews a pending edit before the catalog loads", async () => {
    const pending = Promise.withResolvers<WorkflowRecord>();
    const client: WorkflowClient = {
      create: unused,
      edit: () => pending.promise,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([everyRecord]), client)}>
          <WorkflowEditor workflow={everyRecord} />
        </WorkflowProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");

    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Changed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      await Promise.resolve();
    });

    const save = [...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Save");
    expect(save?.disabled).toBe(false);
    await act(async () => {
      pending.resolve({
        ...everyRecord,
        workingCopy: { ...everyDocument, name: "Changed" },
        workingRevision: 2,
      });
      await pending.promise;
    });
    await act(async () => root.unmount());
  });

  it("publishes the accepted revision after a queued edit fails", async () => {
    const pending = Promise.withResolvers<WorkflowRecord>();
    const publish = vi.fn<WorkflowClient["publish"]>(async () => everyRecord);
    const switchEnabled = vi.fn<WorkflowClient["switchEnabled"]>(async () => ({
      ...everyRecord,
      enabled: true,
    }));
    const client: WorkflowClient = {
      create: unused,
      edit: () => pending.promise,
      publish,
      switchEnabled,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([everyRecord], { catalog, machine }), client)}
        >
          <WorkflowEditor workflow={everyRecord} />
        </WorkflowProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Changed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      await Promise.resolve();
    });
    const save = [...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Save");
    if (!save) throw new Error("Save button did not render");
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
      pending.reject(new Error("edit rejected"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledWith(everyRecord.id, 1);
    expect(container.textContent).toContain("Not saved");
    await act(async () => root.unmount());
  });

  it("shows a live enabled change while an edit preview is pending", async () => {
    const pending = Promise.withResolvers<WorkflowRecord>();
    const client: WorkflowClient = {
      create: unused,
      edit: () => pending.promise,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const { container, render, root } = await mountEditor(everyRecord, client);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Changed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
      await Promise.resolve();
    });
    const live = { ...everyRecord, enabled: true };
    await render(live);

    expect(
      container.querySelector('[aria-label="Turn this Workflow on"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    const save = [...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Save");
    expect(save?.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("keeps the list on/off control disabled until the Workflow is published", async () => {
    const switchEnabled = vi.fn<WorkflowClient["switchEnabled"]>(async () => record);
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), client)}>
          <WorkflowEditor workflow={record} />
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    navigate.mockClear();

    const card = [...container.querySelectorAll<HTMLElement>("[data-slot=card]")].find((element) =>
      element.textContent?.includes("Local name"),
    );
    if (!card) throw new Error("Workflow card did not render");
    const toggle = [...card.querySelectorAll("button")].find((button) => button.textContent === "Off");
    const exportWorkflow = card.querySelector<HTMLButtonElement>('button[aria-label="Export Local name"]');
    const opener = card.querySelector<HTMLAnchorElement>("a");
    if (!toggle) throw new Error("On/Off control did not render");
    if (!exportWorkflow) throw new Error("Export control did not render");
    if (!opener) throw new Error("Workflow card did not open");

    expect(card.querySelector('[role="switch"]')).toBeNull();
    expect(opener.querySelector("button")).toBeNull();
    expect(toggle.closest("a")).toBeNull();
    expect(exportWorkflow.closest("a")).toBeNull();
    expect(toggle.disabled).toBe(true);
    await act(async () => {
      toggle.click();
      exportWorkflow.click();
    });
    expect(switchEnabled).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      opener.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$workflowId",
      params: { workflowId: record.id },
    });
    await act(async () => root.unmount());
  });

  it("shows an import failure on the list and does not create a workflow", async () => {
    const create = vi.fn<WorkflowClient["create"]>(unused);
    const client: WorkflowClient = {
      create,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), client)}>
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Import input did not render");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["{"], "broken.json", { type: "application/json" }));
    input.files = transfer.files;

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      Effect.runSync(
        importWorkflow("{").pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => {
              throw new Error("invalid JSON imported");
            },
          }),
        ),
      ),
    );
    await act(async () => root.unmount());
  });

  it("lists same-code problems with distinct identities", async () => {
    const duplicateLocation = {
      trigger: null,
      operation: null,
      question: null,
      choice: null,
      field: "workflow",
    };
    const workflow: WorkflowRecord = {
      ...record,
      diagnostics: [
        {
          code: "no-trigger",
          class: "incomplete",
          location: duplicateLocation,
          message: "Add a trigger",
        },
      ],
      readiness: [
        {
          code: "no-trigger",
          class: "advisory",
          location: duplicateLocation,
          message: "No trigger is ready",
        },
      ],
    };
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, root } = await mountEditor(workflow, client);
    const problems = container.querySelector<HTMLButtonElement>('[aria-label="2 problems"]');
    if (!problems) throw new Error("Problems button did not render");
    await act(async () => problems.click());

    expect(document.body.textContent).toContain("Add a trigger");
    expect(document.body.textContent).toContain("No trigger is ready");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    await act(async () => root.unmount());
  });

  it("blocks Save for an incomplete problem and never for an advisory one", async () => {
    const location = { trigger: null, operation: null, question: null, choice: null, field: "document" };
    const advisory: WorkflowRecord = {
      ...everyRecord,
      workingRevision: 2,
      readiness: [
        { code: "harness-unavailable", class: "advisory", location, message: "Harness codex is unavailable" },
      ],
    };
    const incomplete: WorkflowRecord = {
      ...advisory,
      diagnostics: [
        { code: "no-trigger", class: "incomplete", location, message: "Workflow has no Trigger" },
      ],
    };
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const { container, render, root } = await mountEditor(advisory, client);
    const save = () =>
      [...container.querySelectorAll("button")].find(({ textContent }) => textContent === "Save");

    expect(save()?.disabled).toBe(false);
    await render(incomplete);
    expect(save()?.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("keeps action options with their answer after removing an earlier action", async () => {
    const pending = Promise.withResolvers<WorkflowRecord>();
    const loadingOptions = Promise.withResolvers<never>();
    const client: WorkflowClient = {
      create: unused,
      edit: () => pending.promise,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: () => loadingOptions.promise,
    };
    const { container, root } = await mountEditor(transitionRecord, client);
    const remove = container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove Done"]');
    expect(remove).toHaveLength(2);
    await act(async () => {
      remove[0]?.click();
      await Promise.resolve();
    });

    const parameter = container.querySelectorAll<HTMLButtonElement>('[aria-label="Done target"]');
    expect(parameter).toHaveLength(1);
    await act(async () => {
      parameter[0]?.click();
      await Promise.resolve();
    });
    expect(
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent),
    ).toContain("second");
    await act(async () => root.unmount());
  });

  it("shows loading only until the first list of trigger options arrives", async () => {
    const firstListing = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const refresh = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [firstListing.promise, refresh.promise];
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: () => listings.shift() ?? refresh.promise,
    };
    const { container, root } = await mountEditor(everyRecord, client);
    const parameter = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!parameter) throw new Error("Trigger parameter did not render");
    const menu = () => document.querySelector('[role="menu"]');
    const optionTexts = () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent);

    await act(async () => parameter.click());
    expect(menu()?.textContent).toContain("Loading");
    await act(async () =>
      firstListing.resolve([{ value: "needs-triage", name: "needs-triage", listedIn: [] }]),
    );
    expect(optionTexts()).toEqual(["needs-triage"]);
    expect(menu()?.textContent).not.toContain("Loading");

    await act(async () => parameter.click());
    await act(async () => parameter.click());
    expect(parameter.getAttribute("aria-expanded")).toBe("true");
    expect(optionTexts()).toEqual(["needs-triage"]);
    expect(menu()?.textContent).not.toContain("Loading");
    await act(async () => root.unmount());
  });

  it("keeps an action's listed options when the Add Action menu opens again", async () => {
    const firstListing = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const refresh = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [firstListing.promise, refresh.promise];
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: () => listings.shift() ?? refresh.promise,
    };
    const { container, root } = await mountEditor(everyRecord, client);
    const addAction = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Add Action",
    );
    if (!addAction) throw new Error("Add Action did not render");
    const menuItem = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        ({ textContent }) => textContent === text,
      );
    const openDoneValues = async () => {
      await act(async () => addAction.click());
      await act(async () => menuItem("Test")?.click());
      await act(async () => menuItem("Done…")?.click());
    };

    await openDoneValues();
    expect(document.body.textContent).toContain("Loading");
    await act(async () =>
      firstListing.resolve([{ value: "needs-triage", name: "needs-triage", listedIn: [] }]),
    );
    expect(menuItem("needs-triage")).toBeDefined();

    await act(async () => addAction.click());
    expect(menuItem("needs-triage")).toBeUndefined();
    await openDoneValues();
    expect(menuItem("needs-triage")).toBeDefined();
    expect(document.body.textContent).not.toContain("Loading");
    await act(async () => root.unmount());
  });

  it("keeps the newest options when an older read settles last", async () => {
    const older = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const newer = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [older.promise, newer.promise];
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: () => listings.shift() ?? newer.promise,
    };
    const { container, root } = await mountEditor(everyRecord, client);
    const parameter = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!parameter) throw new Error("Trigger parameter did not render");
    const optionTexts = () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent);

    await act(async () => parameter.click());
    await act(async () => parameter.click());
    await act(async () => parameter.click());
    await act(async () => newer.resolve([{ value: "new", name: "new", listedIn: [] }]));
    await act(async () => older.resolve([{ value: "old", name: "old", listedIn: [] }]));
    expect(optionTexts()).toEqual(["new"]);
    await act(async () => root.unmount());
  });

  it("lists options for every ready workspace when the Workflow selects Every", async () => {
    const listOptions = vi.fn<WorkflowClient["listOptions"]>(async () => []);
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([everyRecord], { catalog, machine }), client)}
        >
          <WorkflowEditor workflow={everyRecord} />
        </WorkflowProvider>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!trigger) throw new Error("Trigger parameter menu did not render");
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    expect(listOptions).toHaveBeenCalledWith(
      catalog.entries[0]?.key,
      "target",
      machine.workspaces.map(({ id }) => id),
    );
    await act(async () => root.unmount());
  });

  it("keeps a stored workspace in the menu before readiness loads", async () => {
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), client)}>
          <WorkflowEditor workflow={record} />
        </WorkflowProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!trigger) throw new Error("Workspace menu did not render");
    await act(async () => trigger.click());

    expect(
      [...document.querySelectorAll('[role="option"]')].some(({ textContent }) =>
        textContent?.includes("cogwork"),
      ),
    ).toBe(true);
    await act(async () => root.unmount());
  });

  it("names each workspace in the menu instead of showing its id", async () => {
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish: unused,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const workspaceLabels = new Map([
      ["cogwork", "Cogwork"],
      ["first", "First repository"],
      ["second", "Second repository"],
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([record], { machine, workspaceLabels }), client)}
        >
          <WorkflowEditor workflow={record} />
        </WorkflowProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!trigger) throw new Error("Workspace menu did not render");
    expect(trigger.textContent).toContain("Cogwork");
    await act(async () => trigger.click());

    const options = [...document.querySelectorAll('[role="option"]')].map(({ textContent }) => textContent);
    expect(options).toEqual(expect.arrayContaining(["Cogwork", "First repository", "Second repository"]));
    expect(options).not.toContain("first");
    await act(async () => root.unmount());
  });
});
