import {
  type ConnectionOverview,
  type ControlStore,
  type HarnessCatalog,
  type HarnessReadiness,
  type MachineReadiness,
  NeedIdentity,
  type WorkflowCatalog,
  type WorkflowDocument,
  type WorkflowId,
  type WorkflowRecord,
  type WorkflowTemplate,
} from "@cogwork/contracts";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useUpdateEffect } from "@react-hookz/web";
import * as Schema from "effect/Schema";
import { createContext, type ReactNode, use, useState } from "react";

import { useConfiguration } from "../components/configuration-provider";
import {
  createWorkflowAtom,
  deleteWorkflowAtom,
  harnessCatalogsAtom,
  switchWorkflowAtom,
  workflowCatalogAtom,
  workflowsAtom,
  workflowTemplatesAtom,
} from "../daemon/atoms";
import { useActivitySession } from "./activity-session";
import { authorityLabel, type Contribution } from "./configuration-model";
import { DesktopNotificationCoordinator } from "./desktop-notifications";
import { reportRendererError } from "./report-error";
import { workspaceLabel } from "./workspace-record";

export interface WorkflowClient {
  readonly create: (document: WorkflowDocument) => Promise<WorkflowRecord>;
  readonly switchEnabled: (id: WorkflowId, enabled: boolean) => Promise<WorkflowRecord>;
  readonly delete: (id: WorkflowId) => Promise<WorkflowId>;
}

export const enableNotificationsWhenOn = (workflow: WorkflowRecord) => {
  if (!workflow.enabled) return workflow;
  window.cogwork.notifications.enable().catch((error) => reportRendererError(error, "desktop notifications"));
  return workflow;
};

export interface WorkflowHarnesses {
  readonly catalogs: ReadonlyArray<HarnessCatalog> | null;
  readonly readiness: HarnessReadiness | null;
  readonly controlStore: ControlStore | null;
}

export const NeedKind = ["mcp-server", "skill", "subagent", "hook", "connection"] as const;
export type NeedKind = (typeof NeedKind)[number];

/** Something an Operation can require, by the concrete identity the engine checks. */
export interface NeedChoice {
  readonly identity: NeedIdentity;
  readonly kind: NeedKind;
  readonly name: string;
  readonly source: string;
}

export interface WorkflowSessionState {
  readonly workflows: ReadonlyArray<WorkflowRecord>;
  readonly catalog: WorkflowCatalog | null;
  readonly machine: MachineReadiness | null;
  readonly workspaceLabels: ReadonlyMap<string, string>;
  readonly templates: ReadonlyArray<WorkflowTemplate>;
  readonly harnesses: WorkflowHarnesses;
  readonly needs: ReadonlyArray<NeedChoice>;
  readonly loading: boolean;
}

const decodeNeed = Schema.decodeUnknownSync(NeedIdentity);

const isNeedKind = (kind: string): kind is NeedKind => NeedKind.some((candidate) => candidate === kind);

export const needChoices = (
  contributions: ReadonlyArray<Contribution>,
  connections: ConnectionOverview | null,
) => {
  const fromContributions = contributions.flatMap(({ id, kind, localName, authority }) =>
    isNeedKind(kind)
      ? [{ identity: decodeNeed(id), kind, name: localName, source: authorityLabel(authority) }]
      : [],
  );
  const fromConnections = (connections?.connections ?? []).flatMap(({ connection }) =>
    connection === null
      ? []
      : [
          {
            identity: decodeNeed(connection.id),
            kind: "connection" as const,
            name: `${connection.system} · ${connection.account}`,
            source: "",
          },
        ],
  );
  return [...fromContributions, ...fromConnections].filter(
    (need, index, needs) => needs.findIndex(({ identity }) => identity === need.identity) === index,
  );
};

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
  const configuration = useConfiguration();
  const listed = useAtomValue(workflowsAtom);
  const harnessCatalogs = useAtomValue(harnessCatalogsAtom);
  const catalogResult = useAtomValue(workflowCatalogAtom);
  const refreshCatalog = useAtomRefresh(workflowCatalogAtom);
  useUpdateEffect(refreshCatalog, [refreshCatalog, session.workflowInputsRevision]);
  const templatesResult = useAtomValue(workflowTemplatesAtom);
  const create = useAtomSet(createWorkflowAtom, { mode: "promise" });
  const switchEnabled = useAtomSet(switchWorkflowAtom, { mode: "promise" });
  const deleteWorkflow = useAtomSet(deleteWorkflowAtom, { mode: "promise" });
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
    switchEnabled: async (id, enabled) =>
      enableNotificationsWhenOn((await switchEnabled({ payload: { id, enabled } })).workflow),
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
  };
  const value = workflowProviderValue(
    {
      workflows,
      catalog: catalog?.catalog ?? null,
      machine: catalog?.machine ?? null,
      workspaceLabels: new Map(
        [...session.board.workspaces].map(([id, workspace]) => [id, workspaceLabel(workspace)]),
      ),
      templates: templates ?? [],
      harnesses: {
        catalogs: successValue(harnessCatalogs),
        readiness: session.board.harnesses,
        controlStore: session.board.controlStore,
      },
      needs: needChoices(configuration.state.picture.contributions, session.board.connections),
      loading: listed._tag === "Initial" || catalogResult._tag === "Initial",
    },
    client,
    queried?.unreadable ?? [],
  );
  return (
    <WorkflowProvider value={value}>
      <DesktopNotificationCoordinator workflows={workflows} activityOrdinal={session.ordinal} />
      {children}
    </WorkflowProvider>
  );
}
