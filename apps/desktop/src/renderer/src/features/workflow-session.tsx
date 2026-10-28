import type {
  MachineReadiness,
  WorkflowCatalog,
  WorkflowCatalogKey,
  WorkflowDocument,
  WorkflowEditBatch,
  WorkflowId,
  WorkflowOption,
  WorkflowRecord,
  WorkflowTemplate,
  WorkspaceId,
} from "@cogwork/contracts";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useUpdateEffect } from "@react-hookz/web";
import { createContext, type ReactNode, use, useState } from "react";
import {
  applyWorkflowEditAtom,
  createWorkflowAtom,
  deleteWorkflowAtom,
  listWorkflowOptionsAtom,
  publishWorkflowAtom,
  switchWorkflowAtom,
  workflowCatalogAtom,
  workflowsAtom,
  workflowTemplatesAtom,
} from "../daemon/atoms";
import { useActivitySession } from "./activity-session";

export interface WorkflowClient {
  readonly create: (document: WorkflowDocument) => Promise<WorkflowRecord>;
  readonly edit: (id: WorkflowId, edits: WorkflowEditBatch) => Promise<WorkflowRecord>;
  readonly publish: (id: WorkflowId, revision: number) => Promise<WorkflowRecord>;
  readonly switchEnabled: (id: WorkflowId, enabled: boolean) => Promise<WorkflowRecord>;
  readonly delete: (id: WorkflowId) => Promise<WorkflowId>;
  readonly listOptions: (
    entry: WorkflowCatalogKey,
    parameter: string,
    workspaces: ReadonlyArray<WorkspaceId>,
  ) => Promise<ReadonlyArray<WorkflowOption>>;
}

interface WorkflowSessionState {
  readonly workflows: ReadonlyArray<WorkflowRecord>;
  readonly catalog: WorkflowCatalog | null;
  readonly machine: MachineReadiness | null;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
  readonly loading: boolean;
}

interface WorkflowSessionValue {
  readonly state: WorkflowSessionState;
  readonly actions: WorkflowClient;
  readonly meta: { readonly unreadable: ReadonlyArray<{ readonly id: string; readonly message: string }> };
}

const WorkflowSessionContext = createContext<WorkflowSessionValue | null>(null);

export function WorkflowProvider({
  value,
  children,
}: {
  readonly value: WorkflowSessionValue;
  readonly children: ReactNode;
}) {
  return <WorkflowSessionContext value={value}>{children}</WorkflowSessionContext>;
}

export const workflowProviderValue = (
  state: WorkflowSessionState,
  client: WorkflowClient,
  unreadable: WorkflowSessionValue["meta"]["unreadable"] = [],
) => ({ state, actions: client, meta: { unreadable } });

export function useWorkflowSession() {
  const value = use(WorkflowSessionContext);
  if (!value) throw new Error("useWorkflowSession must render inside WorkflowProvider");
  return value;
}

const successValue = <Value,>(result: { readonly _tag: string; readonly value?: Value }) =>
  result._tag === "Success" ? (result.value ?? null) : null;

const mergeWorkflowRecords = (...groups: ReadonlyArray<ReadonlyArray<WorkflowRecord>>) =>
  groups.flat().reduce<ReadonlyMap<WorkflowId, WorkflowRecord>>((records, workflow) => {
    const current = records.get(workflow.id);
    const isNewest = current === undefined || workflow.workingRevision >= current.workingRevision;
    return isNewest ? new Map(records).set(workflow.id, workflow) : records;
  }, new Map());

export function DaemonWorkflowProvider({ children }: { readonly children: ReactNode }) {
  const session = useActivitySession();
  const [createdWorkflows, setCreatedWorkflows] = useState<ReadonlyMap<WorkflowId, WorkflowRecord>>(
    new Map(),
  );
  const listed = useAtomValue(workflowsAtom);
  const catalogResult = useAtomValue(workflowCatalogAtom);
  const refreshCatalog = useAtomRefresh(workflowCatalogAtom);
  useUpdateEffect(refreshCatalog, [refreshCatalog, session.workflowInputsRevision]);
  const templatesResult = useAtomValue(workflowTemplatesAtom);
  const create = useAtomSet(createWorkflowAtom, { mode: "promise" });
  const edit = useAtomSet(applyWorkflowEditAtom, { mode: "promise" });
  const publish = useAtomSet(publishWorkflowAtom, { mode: "promise" });
  const switchEnabled = useAtomSet(switchWorkflowAtom, { mode: "promise" });
  const deleteWorkflow = useAtomSet(deleteWorkflowAtom, { mode: "promise" });
  const listOptions = useAtomSet(listWorkflowOptionsAtom, { mode: "promise" });
  const queried = successValue(listed);
  const catalog = successValue(catalogResult);
  const templates = successValue(templatesResult);
  const queriedWorkflows = session.seed ? (queried?.workflows ?? []) : [];
  const observedWorkflows = mergeWorkflowRecords(queriedWorkflows, [...session.workflows.values()]);
  const createdBeforeEvent = [...createdWorkflows.values()].filter(({ id }) => !observedWorkflows.has(id));
  const workflows = [...observedWorkflows.values(), ...createdBeforeEvent];
  useUpdateEffect(() => {
    setCreatedWorkflows((current) => {
      const pending = new Map([...current].filter(([id]) => !observedWorkflows.has(id)));
      return pending.size === current.size ? current : pending;
    });
  }, [queried?.workflows, session.workflows]);
  const client: WorkflowClient = {
    create: async (document) => {
      const workflow = await create({ payload: { document } });
      setCreatedWorkflows((current) => new Map(current).set(workflow.id, workflow));
      return workflow;
    },
    edit: (id, edits) => edit({ payload: { id, edits } }),
    publish: (id, revision) => publish({ payload: { id, revision } }),
    switchEnabled: async (id, enabled) => (await switchEnabled({ payload: { id, enabled } })).workflow,
    delete: async (id) => {
      const deleted = await deleteWorkflow({ payload: { id } });
      setCreatedWorkflows((current) => {
        if (!current.has(deleted)) return current;
        const pending = new Map(current);
        pending.delete(deleted);
        return pending;
      });
      return deleted;
    },
    listOptions: (entry, parameter, workspaces) => listOptions({ payload: { entry, parameter, workspaces } }),
  };
  const value = workflowProviderValue(
    {
      workflows,
      catalog: catalog?.catalog ?? null,
      machine: catalog?.machine ?? null,
      templates: templates ?? [],
      loading: listed._tag === "Initial" || catalogResult._tag === "Initial",
    },
    client,
    queried?.unreadable ?? [],
  );
  return <WorkflowProvider value={value}>{children}</WorkflowProvider>;
}
