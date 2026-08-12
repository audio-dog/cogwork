import { DaemonRpcs, type RunId } from "@clanker-forge/contracts";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import { electronDaemonBridge } from "./electron-bridge";
import { layerProtocolIpc } from "./protocol";

export class DaemonAtomRpc extends AtomRpc.Service<DaemonAtomRpc>()("DaemonAtomRpc", {
  group: DaemonRpcs,
  protocol: layerProtocolIpc(electronDaemonBridge),
}) {}

export const daemonStatusAtom = DaemonAtomRpc.query("GetStatus", undefined);

export const daemonEventsAtom = DaemonAtomRpc.query("WatchEvents", undefined);

// `query` keys its atom by object identity, so calling it inline per render would rebuild the stream
// each time; the family hands out one stable pull atom per run.
export const runActivityAtom = Atom.family((runId: RunId) =>
  DaemonAtomRpc.query("WatchActivity", { id: runId }),
);

export const cancelRunAtom = DaemonAtomRpc.mutation("CancelRun");

export const reclassifyAtom = DaemonAtomRpc.mutation("Reclassify");

export const setSchedulingAtom = DaemonAtomRpc.mutation("SetScheduling");
