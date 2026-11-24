// @vitest-environment happy-dom

import * as Effect from "effect/Effect";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowEditor } from "../components/workflow-editor";
import { WorkflowsList } from "../components/workflows-list";
import { navigate } from "../testing/router-links";
import { openTestWorkingCopies } from "../testing/working-copies";
import { importReviewMark } from "./workflow-import-review";
import { type WorkflowClient, WorkflowProvider, workflowProviderValue } from "./workflow-session";
import {
  buttonNamed,
  catalog,
  decodeWorkflowId,
  disposers,
  eventually,
  everyRecord,
  everyDocument,
  mountEditor,
  record,
  sessionClient,
  sessionState,
  unmountEditors,
  unused,
  workflowDocument,
} from "./workflow-session-fixtures";
import { exportWorkflow, importWorkflow } from "./workflow-transfer";
import { WorkingCopiesProvider } from "./working-copy-provider";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("../testing/router-links")).withRouterLinks(
    await importOriginal<typeof import("@tanstack/react-router")>(),
  ),
);

afterEach(unmountEditors);

describe("WorkflowEditor", () => {
  it("keeps the list on/off control disabled until the Workflow is published", async () => {
    const switchEnabled = vi.fn<WorkflowClient["switchEnabled"]>(async () => record);
    const copies = await openTestWorkingCopies([record]);
    disposers.push(copies.dispose);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([record]), { ...sessionClient, switchEnabled })}
        >
          <WorkingCopiesProvider client={copies.client}>
            <WorkflowEditor workflow={record} />
          </WorkingCopiesProvider>
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
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), { ...sessionClient, create })}>
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

  it("imports a workflow file dropped on the list", async () => {
    const imported = { ...record, id: decodeWorkflowId("workflow-imported") };
    const create = vi.fn<WorkflowClient["create"]>(async () => imported);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), { ...sessionClient, create })}>
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    navigate.mockClear();
    const view = container.firstElementChild;
    if (!(view instanceof HTMLElement)) throw new Error("Workflow list did not render");
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([exportWorkflow(workflowDocument)], "local-name.json", { type: "application/json" }),
    );
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    await act(async () => {
      view.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(create).toHaveBeenCalledWith(workflowDocument);
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$workflowId/review",
      params: { workflowId: imported.id },
    });
    await act(async () => root.unmount());
  });

  it("highlights imported fields until they are saved and then leaves the review", async () => {
    const operation = everyDocument.operations[0];
    if (!operation) throw new Error("expected an operation");
    const draft = { ...everyRecord, publishedCopy: null, publishedRevision: null };
    const onPublished = vi.fn<() => void>();
    const { container, root } = await mountEditor(draft, {
      session: { catalog },
      importReview: [importReviewMark.workspaces, importReviewMark.model(operation.id)],
      onPublished,
    });

    expect(container.textContent).toContain("Review these before you turn this on");
    expect(container.querySelector(`[data-import-review="${importReviewMark.workspaces}"]`)).not.toBeNull();
    expect(
      container.querySelector(`[data-import-review="${importReviewMark.model(operation.id)}"]`),
    ).not.toBeNull();

    const workspaces = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!workspaces) throw new Error("Workspace menu did not render");
    await act(async () => workspaces.click());
    const noWorkspace = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes("No workspace"),
    );
    if (!noWorkspace) throw new Error("No workspace was not offered");
    await act(async () => noWorkspace.click());

    expect(container.querySelector(`[data-import-review="${importReviewMark.workspaces}"]`)).toBeNull();
    expect(
      container.querySelector(`[data-import-review="${importReviewMark.model(operation.id)}"]`),
    ).not.toBeNull();
    expect(container.textContent).toContain("Review these before you turn this on");

    await act(async () => buttonNamed(container, "Save")?.click());

    await eventually(() => expect(onPublished).toHaveBeenCalledTimes(1));
    await act(async () => root.unmount());
  });
});
