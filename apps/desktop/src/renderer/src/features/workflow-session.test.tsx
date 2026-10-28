// @vitest-environment happy-dom

import {
  MachineReadiness,
  PrincipalId,
  WorkflowCatalog,
  WorkflowDocument,
  WorkflowId,
  type WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "../components/workflow-editor";
import { WorkflowsList } from "../components/workflows-list";
import { type WorkflowClient, WorkflowProvider, workflowProviderValue } from "./workflow-session";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: () => <a href="/workflows">Workflows</a>,
  useNavigate: () => async () => undefined,
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
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
  ],
  instructionPackages: [],
  harnesses: [{ name: "codex", models: [{ id: "gpt-5", options: [] }] }],
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

const mountEditor = async (workflow: WorkflowRecord, client: WorkflowClient) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (current: WorkflowRecord) =>
    act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [current], catalog, machine, templates: [], loading: false },
            client,
          )}
        >
          <WorkflowEditor workflow={current} />
        </WorkflowProvider>,
      );
    });
  await render(workflow);
  return { container, render, root };
};

afterEach(() => {
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
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [record], catalog: null, machine: null, templates: [], loading: false },
            client,
          )}
        >
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

  it("publishes the latest live revision", async () => {
    const live = { ...record, workingRevision: 3 };
    const publish = vi.fn<WorkflowClient["publish"]>(async () => live);
    const client: WorkflowClient = {
      create: unused,
      edit: unused,
      publish,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const renderEditor = (workflow: WorkflowRecord) => (
      <WorkflowProvider
        value={workflowProviderValue(
          { workflows: [workflow], catalog: null, machine: null, templates: [], loading: false },
          client,
        )}
      >
        <WorkflowEditor workflow={workflow} />
      </WorkflowProvider>
    );
    await act(async () => root.render(renderEditor(record)));
    await act(async () => root.render(renderEditor(live)));
    const publishButton = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Publish",
    );
    if (!publishButton) throw new Error("Publish button did not render");

    await act(async () => {
      publishButton.click();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledWith(record.id, 3);
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
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [everyRecord], catalog: null, machine: null, templates: [], loading: false },
            client,
          )}
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

    const publishButton = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Publish",
    );
    expect(publishButton?.disabled).toBe(false);
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
    const client: WorkflowClient = {
      create: unused,
      edit: () => pending.promise,
      publish,
      switchEnabled: unused,
      delete: unused,
      listOptions: unused,
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [everyRecord], catalog, machine, templates: [], loading: false },
            client,
          )}
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
    const publishButton = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Publish",
    );
    if (!publishButton) throw new Error("Publish button did not render");
    expect(publishButton.disabled).toBe(false);
    await act(async () => {
      publishButton.click();
      pending.reject(new Error("edit rejected"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledWith(everyRecord.id, 1);
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
    await act(async () => root.unmount());
  });

  it("disables enable controls until the Workflow is published", async () => {
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
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [record], catalog: null, machine: null, templates: [], loading: false },
            client,
          )}
        >
          <WorkflowEditor workflow={record} />
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });

    const switches = [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
    expect(switches).toHaveLength(2);
    expect(switches.every((control) => control.getAttribute("aria-disabled") === "true")).toBe(true);
    switches.forEach((control) => {
      control.click();
    });
    expect(switchEnabled).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("renders same-code diagnostics with distinct identities", async () => {
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

    expect(
      [...container.querySelectorAll("[data-diagnostic-class]")].map(({ textContent }) => textContent),
    ).toEqual(expect.arrayContaining(["incompleteAdd a trigger", "advisoryNo trigger is ready"]));
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    await act(async () => root.unmount());
  });

  it("keeps transition options with their answer after removing an earlier transition", async () => {
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
    const remove = container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove Transition"]');
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
    expect([...document.querySelectorAll('[role="option"]')].map(({ textContent }) => textContent)).toContain(
      "second",
    );
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
          value={workflowProviderValue(
            { workflows: [everyRecord], catalog, machine, templates: [], loading: false },
            client,
          )}
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
        <WorkflowProvider
          value={workflowProviderValue(
            { workflows: [record], catalog: null, machine: null, templates: [], loading: false },
            client,
          )}
        >
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
});
