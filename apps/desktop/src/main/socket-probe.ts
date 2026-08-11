import * as net from "node:net";

export const isDaemonListening = (socketPath: string, timeoutMillis = 500): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });

    const settle = (listening: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(timeoutMillis, () => settle(false));
  });
