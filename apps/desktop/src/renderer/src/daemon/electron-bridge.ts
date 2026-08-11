import type { DaemonRpcBridge } from "../../../shared/ipc";

export const electronDaemonBridge: DaemonRpcBridge = {
  connect: () => window.clankerForge.rpc.connect(),
  send: (frame) => window.clankerForge.rpc.send(frame),
  onData: (listener) => window.clankerForge.rpc.onData(listener),
  onClosed: (listener) => window.clankerForge.rpc.onClosed(listener),
};
