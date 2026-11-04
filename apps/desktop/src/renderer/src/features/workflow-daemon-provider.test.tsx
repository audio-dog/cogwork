// @vitest-environment happy-dom

import { PrincipalId, WorkflowDocument, WorkflowId, type WorkflowRecord } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Configuration } from "../components/configuration-provider";
import {
  createWorkflowAtom,
  harnessCatalogsAtom,
  switchWorkflowAtom,
  workflowCatalogAtom,
  workflowsAtom,
  workflowTemplatesAtom,
} from "../daemon/atoms";
import { ActivitySessionContext, initialActivitySession } from "./activity-session";
import { DaemonWorkflowProvider, useWorkflowSession } from "./workflow-session";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const enableNotifications = vi.hoisted(() => vi.fn(async () => ({ _tag: "ready" as const })));

vi.mock("./desktop-notifications", () => ({ DesktopNotificationCoordinator: () => null }));

const atomActions: Map<unknown, (value: unknown) => Promise<unknown>> = vi.hoisted(() => new Map());
const atomValues: Map<unknown, unknown> = vi.hoisted(() => new Map());

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomRefresh: () => () => undefined,
    useAtomSet: (atom: unknown) => atomActions.get(atom),
    useAtomValue: (atom: unknown) => atomValues.get(atom),
  };
});

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodePrincipalId = Schema.decodeUnknownSync(PrincipalId);
const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);

const workflowDocument = decodeDocument({
  name: "Created Workflow",
  workspaces: { _tag: "Every" },
  triggers: [],
  operations: [],
});

const record: WorkflowRecord = {
  id: decodeWorkflowId("created-workflow"),
  principal: decodePrincipalId("person"),
  workingCopy: workflowDocument,
  workingRevision: 1,
  publishedCopy: null,
  publishedRevision: null,
  enabled: false,
  diagnostics: [],
  readiness: [],
};

function SessionProbe() {
  const { state, actions } = useWorkflowSession();
  return (
    <>
      <button type="button" onClick={async () => actions.create(workflowDocument)}>
        Create
      </button>
      <button type="button" onClick={async () => actions.switchEnabled(record.id, true)}>
        Turn on
      </button>
      <output>{state.workflows.map(({ workingCopy }) => workingCopy.name).join(",")}</output>
    </>
  );
}

describe("DaemonWorkflowProvider", () => {
  beforeEach(() => {
    atomActions.clear();
    atomValues.clear();
    atomActions.set(createWorkflowAtom, async () => record);
    atomActions.set(switchWorkflowAtom, async () => ({ workflow: { ...record, enabled: true } }));
    Reflect.set(window, "cogwork", { notifications: { enable: enableNotifications } });
    enableNotifications.mockClear();
    atomValues.set(workflowsAtom, {
      _tag: "Success",
      waiting: false,
      value: { workflows: [], unreadable: [] },
    });
    atomValues.set(workflowCatalogAtom, { _tag: "Initial", waiting: false });
    atomValues.set(harnessCatalogsAtom, { _tag: "Initial", waiting: false });
    atomValues.set(workflowTemplatesAtom, { _tag: "Initial", waiting: false });
  });

  it("shows a created Workflow before its change event arrives", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ActivitySessionContext value={{ ...initialActivitySession, seed: false }}>
          <Configuration.Provider
            picture={{ workspaces: [], plugins: [], catalogPlugins: [], contributions: [] }}
          >
            <DaemonWorkflowProvider>
              <SessionProbe />
            </DaemonWorkflowProvider>
          </Configuration.Provider>
        </ActivitySessionContext>,
      );
    });
    const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Create",
    );
    if (!create) throw new Error("Create button did not render");

    await act(async () => {
      create.click();
      await Promise.resolve();
    });

    expect(container.querySelector("output")?.textContent).toBe("Created Workflow");
    await act(async () => root.unmount());
  });

  it("enables OS notifications when a Workflow is switched on", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <ActivitySessionContext value={{ ...initialActivitySession, seed: false }}>
          <Configuration.Provider
            picture={{ workspaces: [], plugins: [], catalogPlugins: [], contributions: [] }}
          >
            <DaemonWorkflowProvider>
              <SessionProbe />
            </DaemonWorkflowProvider>
          </Configuration.Provider>
        </ActivitySessionContext>,
      );
    });
    const turnOn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      ({ textContent }) => textContent === "Turn on",
    );
    if (!turnOn) throw new Error("Turn on button did not render");

    await act(async () => {
      turnOn.click();
      await Promise.resolve();
    });

    expect(enableNotifications).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
