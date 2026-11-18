import type {
  MachineReadiness,
  WorkflowCatalogKey,
  WorkflowId,
  WorkflowOption,
  WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { createContext, type ReactNode, use } from "react";
import type { ListValues } from "../components/workflow-catalog-menu";
import { DaemonAtomRpc } from "../daemon/atoms";
import { boundDaemonCall, layer as workingCopyDaemonLayer } from "../daemon/working-copy-daemon";
import { reportRendererError } from "./report-error";
import { enableNotificationsWhenOn, useWorkflowSession } from "./workflow-session";
import {
  type SaveStatus,
  viewOf,
  WorkingCopies,
  type WorkingCopyInput,
  WorkingCopyInputInvalid,
  type WorkingCopySnapshot,
  layer as workingCopiesLayer,
} from "./working-copy";

export type ListWorkflowOptions = (
  entry: WorkflowCatalogKey,
  parameter: string,
  workspaces: ReadonlyArray<WorkspaceId>,
) => Effect.Effect<ReadonlyArray<WorkflowOption>, unknown>;

export const makeWorkingCopiesClient = Effect.fn("WorkingCopies.client")(function* (
  listOptions: ListWorkflowOptions,
) {
  const copies = yield* WorkingCopies;
  const run = yield* FiberSet.makeRuntimePromise();
  const snapshot = Atom.family((id: WorkflowId) => Atom.make(copies.snapshots(id)));
  return {
    edit: (id: WorkflowId, input: WorkingCopyInput) => run(copies.edit(id, input)),
    publish: (id: WorkflowId) => run(copies.publish(id)),
    switchEnabled: (id: WorkflowId, enabled: boolean) => run(copies.switchEnabled(id, enabled)),
    snapshot,
    listOptions: (entry: WorkflowCatalogKey, parameter: string, workspaces: ReadonlyArray<WorkspaceId>) =>
      run(listOptions(entry, parameter, workspaces)),
  };
});

export type WorkingCopiesClient = Effect.Success<ReturnType<typeof makeWorkingCopiesClient>>;

export const workingCopiesAtom = Atom.keepAlive(
  DaemonAtomRpc.runtime.atom(
    Effect.gen(function* () {
      const rpc = yield* DaemonAtomRpc;
      const services = yield* Layer.build(workingCopiesLayer.pipe(Layer.provide(workingCopyDaemonLayer)));
      return yield* makeWorkingCopiesClient((entry, parameter, workspaces) =>
        boundDaemonCall(rpc("ListWorkflowOptions", { entry, parameter, workspaces })),
      ).pipe(Effect.provideContext(services));
    }),
  ),
);

const WorkingCopiesContext = createContext<WorkingCopiesClient | null>(null);

export function WorkingCopiesProvider({
  client,
  children,
}: {
  readonly client: WorkingCopiesClient | null;
  readonly children: ReactNode;
}) {
  return <WorkingCopiesContext value={client}>{children}</WorkingCopiesContext>;
}

export function DaemonWorkingCopiesProvider({ children }: { readonly children: ReactNode }) {
  const result = useAtomValue(workingCopiesAtom);
  return (
    <WorkingCopiesProvider client={AsyncResult.isSuccess(result) ? result.value : null}>
      {children}
    </WorkingCopiesProvider>
  );
}

export interface WorkingCopyField {
  readonly value: string;
  readonly save: (text: string) => Promise<string>;
}

interface WorkingCopyValue {
  readonly state: { readonly workflow: WorkflowRecord; readonly saveStatus: SaveStatus };
  readonly actions: {
    readonly field: (
      read: (workflow: WorkflowRecord) => string,
      write: (text: string) => WorkingCopyInput,
    ) => WorkingCopyField;
    readonly edit: (input: WorkingCopyInput) => void;
    readonly publish: () => void;
    readonly switchEnabled: (enabled: boolean) => void;
  };
  readonly meta: { readonly listValues: ListValues };
}

const WorkingCopyContext = createContext<WorkingCopyValue | null>(null);

export function useWorkingCopy() {
  const value = use(WorkingCopyContext);
  if (!value) throw new Error("useWorkingCopy must render inside WorkingCopyProvider");
  return value;
}

const reportFailure = (error: unknown) => reportRendererError(error, "workflow working copy");

const workspaceIds = (workflow: WorkflowRecord, machine: MachineReadiness | null) =>
  workflow.workingCopy.workspaces._tag === "Listed"
    ? workflow.workingCopy.workspaces.workspaces
    : (machine?.workspaces.map(({ id }) => id) ?? []);

function OpenWorkingCopy({
  copies,
  opened,
  onPublished,
  children,
}: {
  readonly copies: WorkingCopiesClient;
  readonly opened: WorkflowRecord;
  readonly onPublished?: () => void;
  readonly children: ReactNode;
}) {
  const { state: session } = useWorkflowSession();
  const result = useAtomValue(copies.snapshot(opened.id));
  const snapshot: WorkingCopySnapshot = AsyncResult.isSuccess(result)
    ? result.value
    : { accepted: opened, pending: [], saveStatus: "saved" };
  const workflow = viewOf(snapshot, session.catalog, session.machine);
  const keepOnInvalidInput = (read: (workflow: WorkflowRecord) => string) => (error: unknown) => {
    if (error instanceof WorkingCopyInputInvalid) return read(workflow);
    throw error;
  };
  const value: WorkingCopyValue = {
    state: { workflow, saveStatus: snapshot.saveStatus },
    actions: {
      field: (read, write) => ({
        value: read(workflow),
        save: (text) => copies.edit(workflow.id, write(text)).then(read, keepOnInvalidInput(read)),
      }),
      edit: (input) => {
        copies.edit(workflow.id, input).catch(reportFailure);
      },
      publish: () => {
        copies
          .publish(workflow.id)
          .then(() => onPublished?.())
          .catch(reportFailure);
      },
      switchEnabled: (enabled) => {
        copies.switchEnabled(workflow.id, enabled).then(enableNotificationsWhenOn).catch(reportFailure);
      },
    },
    meta: {
      listValues: async (entry, parameter) =>
        (await copies.listOptions(entry.key, parameter.id, workspaceIds(workflow, session.machine))).map(
          (option) => ({ value: option.value, label: option.name }),
        ),
    },
  };
  return <WorkingCopyContext value={value}>{children}</WorkingCopyContext>;
}

export function WorkingCopyProvider({
  workflow,
  onPublished,
  children,
}: {
  readonly workflow: WorkflowRecord;
  readonly onPublished?: () => void;
  readonly children: ReactNode;
}) {
  const copies = use(WorkingCopiesContext);
  if (!copies) return null;
  return (
    <OpenWorkingCopy copies={copies} opened={workflow} onPublished={onPublished}>
      {children}
    </OpenWorkingCopy>
  );
}
