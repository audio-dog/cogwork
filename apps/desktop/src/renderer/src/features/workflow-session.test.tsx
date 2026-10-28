import {
  PrincipalId,
  WorkflowDocument,
  WorkflowId,
  type WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  submitWorkflowField,
  useWorkflowSession,
  type WorkflowClient,
  WorkflowProvider,
  workflowProviderValue,
} from "./workflow-session";

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodePrincipalId = Schema.decodeUnknownSync(PrincipalId);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);

const document = decodeDocument({
  name: "Local name",
  workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("cogwork")] },
  triggers: [],
  operations: [],
});

const record: WorkflowRecord = {
  id: decodeWorkflowId("workflow-1"),
  principal: decodePrincipalId("person"),
  workingCopy: document,
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

describe("WorkflowProvider", () => {
  it("sends one tagged field edit and returns the daemon value", async () => {
    const edit = vi.fn<WorkflowClient["edit"]>(async (_id, edits) => ({
      ...record,
      workingCopy: { ...document, name: edits[0]._tag === "Rename" ? "Daemon name" : document.name },
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
    const captured: { current: ReturnType<typeof useWorkflowSession> | null } = { current: null };
    function Probe() {
      captured.current = useWorkflowSession();
      return null;
    }
    renderToStaticMarkup(
      <WorkflowProvider
        value={workflowProviderValue(
          { workflows: [record], catalog: null, machine: null, templates: [], loading: false },
          client,
        )}
      >
        <Probe />
      </WorkflowProvider>,
    );
    const session = captured.current;
    if (!session) throw new Error("provider did not render");

    const submitted = { current: record.workingCopy.name };
    const save = (name: string) =>
      session.actions.edit(record.id, [{ _tag: "Rename", name }]).then((updated) => updated.workingCopy.name);
    const returned = await Promise.all([
      submitWorkflowField(submitted, "Typed name", save),
      submitWorkflowField(submitted, "Typed name", save),
    ]);

    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith(record.id, [{ _tag: "Rename", name: "Typed name" }]);
    expect(returned).toContain("Daemon name");
  });
});
