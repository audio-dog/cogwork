import {
  type ConnectionBindingId,
  DaemonRpcs,
  type OperationSettingBatch,
  type RunId,
  type WorkflowCatalogKey,
  type WorkflowEditBatch,
  type WorkflowId,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Stream from "effect/Stream";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { electronDaemonBridge } from "./electron-bridge";
import { reportDesktopProcessHealth } from "./process-health";
import { layerProtocolIpc } from "./protocol";

export class DaemonAtomRpc extends AtomRpc.Service<DaemonAtomRpc>()("DaemonAtomRpc", {
  group: DaemonRpcs,
  protocol: layerProtocolIpc(electronDaemonBridge),
  makeEffect: Effect.gen(function* () {
    const client = yield* RpcClient.make(DaemonRpcs, { flatten: true });
    const runPromise = yield* FiberSet.makeRuntimePromise();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        window.cogwork.onSystemResume(() =>
          runPromise(
            client("CheckHarnesses", undefined).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.logError("Harness readiness wake check failed", { cause }),
              ),
            ),
          ),
        ),
      ),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* reportDesktopProcessHealth(
      () => window.cogwork.getProcessHealth(),
      (samples) => client("ReportProcessHealth", { samples }),
    ).pipe(Effect.forkScoped);
    return client;
  }),
}) {}

export const pullChunkSize = 256;

export const boundPullChunks = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(
    Stream.chunks,
    Stream.flatMap((chunk) => Stream.fromIterable(chunk).pipe(Stream.rechunk(pullChunkSize))),
  );

export const daemonEventAtom = DaemonAtomRpc.runtime.pull(
  Stream.unwrap(DaemonAtomRpc.use((client) => Effect.succeed(client("WatchEvents", undefined)))),
  { disableAccumulation: true },
);

export const runActivityAtom = Atom.family((runId: RunId) =>
  DaemonAtomRpc.runtime.pull(
    Stream.unwrap(DaemonAtomRpc.use((client) => Effect.succeed(client("WatchActivity", { id: runId })))).pipe(
      boundPullChunks,
    ),
    { disableAccumulation: true },
  ),
);

export const cancelRunAtom = DaemonAtomRpc.mutation("CancelRun");

export const reclassifyAtom = DaemonAtomRpc.mutation("Reclassify");

export const handBackAtom = Atom.keepAlive(DaemonAtomRpc.mutation("HandBack"));

export const handBackTargetAtom = Atom.keepAlive(
  Atom.make<{
    readonly workspace: WorkspaceId;
    readonly workItem: WorkItemId;
  } | null>(null),
);

export const setSchedulingAtom = DaemonAtomRpc.mutation("SetScheduling");

export const setDaemonLimitAtom = DaemonAtomRpc.mutation("SetDaemonLimit");

export const setContributionSettingAtom = DaemonAtomRpc.mutation("SetContributionSetting");

export const setOperationSettingAtom = Atom.family((_workspace: WorkspaceId) =>
  DaemonAtomRpc.runtime.fn<{
    readonly payload: { readonly updates: OperationSettingBatch };
  }>()(({ payload }) => Effect.flatMap(DaemonAtomRpc, (client) => client("SetOperationSetting", payload)), {
    concurrent: true,
  }),
);

export const pluginsAtom = DaemonAtomRpc.query("GetPlugins", undefined);

export const connectionsAtom = DaemonAtomRpc.query("GetConnections", undefined);

export const harnessCatalogsAtom = Atom.keepAlive(DaemonAtomRpc.query("GetHarnessCatalogs", undefined));

export const harnessReadinessAtom = Atom.keepAlive(DaemonAtomRpc.query("GetHarnessReadiness", undefined));

export const checkHarnessesAtom = DaemonAtomRpc.mutation("CheckHarnesses");

const githubPriorityFieldsForWorkspaceAtom = Atom.family((workspace: WorkspaceId) =>
  Atom.family((connection: ConnectionBindingId) =>
    DaemonAtomRpc.query("GetGitHubPriorityFields", { workspace, connection }),
  ),
);

export const githubPriorityFieldsAtom = (workspace: WorkspaceId, connection: ConnectionBindingId) =>
  githubPriorityFieldsForWorkspaceAtom(workspace)(connection);

export const setHarnessEnabledAtom = DaemonAtomRpc.mutation("SetHarnessEnabled");

export const installPluginAtom = DaemonAtomRpc.mutation("InstallPlugin");

export const uninstallPluginAtom = DaemonAtomRpc.mutation("UninstallPlugin");

export const establishConnectionAtom = DaemonAtomRpc.mutation("EstablishConnection");

export const loginGranolaAtom = DaemonAtomRpc.mutation("LoginGranola");

export const reconnectConnectionAtom = DaemonAtomRpc.mutation("ReconnectConnection");

export const removeConnectionAtom = DaemonAtomRpc.mutation("RemoveConnection");

export const registerWorkspaceAtom = DaemonAtomRpc.mutation("RegisterWorkspace");

export const updateWorkspaceAtom = DaemonAtomRpc.mutation("UpdateWorkspace");

export const deregisterWorkspaceAtom = DaemonAtomRpc.mutation("DeregisterWorkspace");

export const rebindWorkspaceAtom = DaemonAtomRpc.mutation("RebindWorkspace");

export const workflowsAtom = DaemonAtomRpc.query("ListWorkflows", undefined);

export const workflowCatalogAtom = Atom.keepAlive(DaemonAtomRpc.query("GetWorkflowCatalog", undefined));

export const workflowTemplatesAtom = Atom.keepAlive(DaemonAtomRpc.query("GetWorkflowTemplates", undefined));

export const createWorkflowAtom = DaemonAtomRpc.mutation("CreateWorkflow");

export const publishWorkflowAtom = DaemonAtomRpc.mutation("PublishWorkflow");

export const switchWorkflowAtom = DaemonAtomRpc.mutation("SwitchWorkflow");

export const deleteWorkflowAtom = DaemonAtomRpc.mutation("DeleteWorkflow");

export const listWorkflowOptionsAtom = DaemonAtomRpc.runtime.fn<{
  readonly payload: {
    readonly entry: WorkflowCatalogKey;
    readonly parameter: string;
    readonly workspaces: ReadonlyArray<WorkspaceId>;
  };
}>()(({ payload }) => Effect.flatMap(DaemonAtomRpc, (client) => client("ListWorkflowOptions", payload)), {
  concurrent: true,
});

export const applyWorkflowEditAtom = DaemonAtomRpc.runtime.fn<{
  readonly payload: { readonly id: WorkflowId; readonly edits: WorkflowEditBatch };
}>()(({ payload }) => Effect.flatMap(DaemonAtomRpc, (client) => client("EditWorkflow", payload)), {
  concurrent: true,
});
