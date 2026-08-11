import * as net from "node:net";

export interface DaemonBridgeSink {
  readonly onData: (frame: Uint8Array) => void;
  readonly onClosed: (reason: string | null) => void;
}

export interface DaemonBridgePort {
  readonly connect: () => Promise<void>;
  readonly send: (frame: string) => void;
  readonly dispose: () => void;
}

export const createDaemonBridgePort = (socketPath: string, sink: DaemonBridgeSink): DaemonBridgePort => {
  const state: { socket: net.Socket | null } = { socket: null };

  const detach = () => {
    const socket = state.socket;
    if (!socket) return;
    state.socket = null;
    socket.removeAllListeners();
    socket.destroy();
  };

  const connect = (): Promise<void> =>
    new Promise((resolve, reject) => {
      if (state.socket && !state.socket.destroyed) {
        resolve();
        return;
      }
      detach();

      const socket = net.createConnection({ path: socketPath });
      state.socket = socket;

      const onError = (error: Error) => {
        socket.removeListener("connect", onConnect);
        if (state.socket === socket) state.socket = null;
        socket.destroy();
        reject(error);
      };

      const onConnect = () => {
        socket.removeListener("error", onError);
        socket.on("data", (chunk: Buffer) => sink.onData(chunk));
        socket.on("error", (error: Error) => {
          if (state.socket !== socket) return;
          state.socket = null;
          sink.onClosed(error.message);
        });
        socket.on("close", () => {
          if (state.socket !== socket) return;
          state.socket = null;
          sink.onClosed(null);
        });
        resolve();
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

  const send = (frame: string) => {
    state.socket?.write(frame);
  };

  return { connect, send, dispose: detach };
};
