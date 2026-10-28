// @vitest-environment happy-dom

import {
  PrincipalId,
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

const unused = async () => {
  throw new Error("unexpected call");
};

afterEach(() => {
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
