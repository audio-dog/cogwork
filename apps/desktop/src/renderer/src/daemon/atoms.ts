import { DaemonRpcs, type RunId } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import { electronDaemonBridge } from "./electron-bridge";
import { layerProtocolIpc } from "./protocol";

export class DaemonAtomRpc extends AtomRpc.Service<DaemonAtomRpc>()("DaemonAtomRpc", {
  group: DaemonRpcs,
  protocol: layerProtocolIpc(electronDaemonBridge),
}) {}

export const daemonEventAtom = DaemonAtomRpc.runtime.pull(
  Stream.unwrap(DaemonAtomRpc.use((client) => Effect.succeed(client("WatchEvents", undefined)))),
  { disableAccumulation: true },
);

// `query` keys its atom by object identity, so calling it inline per render would rebuild the stream
// each time; the family hands out one stable pull atom per run.
export const runActivityAtom = Atom.family((runId: RunId) =>
  DaemonAtomRpc.query("WatchActivity", { id: runId }),
);

export const cancelRunAtom = DaemonAtomRpc.mutation("CancelRun");

export const reclassifyAtom = DaemonAtomRpc.mutation("Reclassify");

export const setSchedulingAtom = DaemonAtomRpc.mutation("SetScheduling");

export const setDaemonLimitAtom = DaemonAtomRpc.mutation("SetDaemonLimit");

export const installPluginAtom = DaemonAtomRpc.mutation("InstallPlugin");

export const uninstallPluginAtom = DaemonAtomRpc.mutation("UninstallPlugin");
