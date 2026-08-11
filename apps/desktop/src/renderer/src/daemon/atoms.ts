import { DaemonRpcs } from "@clanker-forge/contracts";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import { electronDaemonBridge } from "./electron-bridge";
import { layerProtocolIpc } from "./protocol";

export class DaemonAtomRpc extends AtomRpc.Service<DaemonAtomRpc>()("DaemonAtomRpc", {
  group: DaemonRpcs,
  protocol: layerProtocolIpc(electronDaemonBridge),
}) {}

export const daemonStatusAtom = DaemonAtomRpc.query("GetStatus", undefined);

export const daemonEventsAtom = DaemonAtomRpc.query("WatchEvents", undefined);
