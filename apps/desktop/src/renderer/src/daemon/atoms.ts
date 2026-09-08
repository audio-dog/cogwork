import {
  DaemonRpcs,
  type OperationSettingName,
  type RunId,
  type WorkItemId,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
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

// One mutation atom per workspace and setting. `Atom.fn` is non-concurrent, so a second call
// on the same atom interrupts the first — and choosing a model writes both the harness and
// the model. The workspace is in the key because an atom outlives the page: without it one
// workspace's failure disables and reports on the next.
export const setOperationSettingAtom = Atom.family((_key: string) =>
  DaemonAtomRpc.mutation("SetOperationSetting"),
);

export const operationSettingAtomKey = (workspace: WorkspaceId, setting: OperationSettingName) =>
  `${workspace}/${setting}`;

export const pluginsAtom = DaemonAtomRpc.query("GetPlugins", undefined);

export const connectionsAtom = DaemonAtomRpc.query("GetConnections", undefined);

// Reading this spawns every installed harness's CLI. Never put it on a timer.
export const harnessesAtom = Atom.keepAlive(DaemonAtomRpc.query("GetHarnesses", undefined));

export const setHarnessEnabledAtom = DaemonAtomRpc.mutation("SetHarnessEnabled");

export const installPluginAtom = DaemonAtomRpc.mutation("InstallPlugin");

export const uninstallPluginAtom = DaemonAtomRpc.mutation("UninstallPlugin");

export const establishConnectionAtom = DaemonAtomRpc.mutation("EstablishConnection");

export const reconnectConnectionAtom = DaemonAtomRpc.mutation("ReconnectConnection");

export const removeConnectionAtom = DaemonAtomRpc.mutation("RemoveConnection");

export const registerWorkspaceAtom = DaemonAtomRpc.mutation("RegisterWorkspace");

export const updateWorkspaceAtom = DaemonAtomRpc.mutation("UpdateWorkspace");

export const deregisterWorkspaceAtom = DaemonAtomRpc.mutation("DeregisterWorkspace");

export const rebindWorkspaceAtom = DaemonAtomRpc.mutation("RebindWorkspace");
