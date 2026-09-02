import type { DaemonRpcBridge } from "../../../shared/ipc";

export const electronDaemonBridge: DaemonRpcBridge = {
  connect: (sessionId) => window.cogwork.rpc.connect(sessionId),
  disconnect: () => window.cogwork.rpc.disconnect(),
  send: (frame) => window.cogwork.rpc.send(frame),
  onData: (listener) => window.cogwork.rpc.onData(listener),
  onClosed: (listener) => window.cogwork.rpc.onClosed(listener),
};
