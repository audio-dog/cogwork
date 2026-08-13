import type { DaemonRpcBridge } from "../../../shared/ipc";

export const electronDaemonBridge: DaemonRpcBridge = {
  connect: () => window.cogwork.rpc.connect(),
  send: (frame) => window.cogwork.rpc.send(frame),
  onData: (listener) => window.cogwork.rpc.onData(listener),
  onClosed: (listener) => window.cogwork.rpc.onClosed(listener),
};
