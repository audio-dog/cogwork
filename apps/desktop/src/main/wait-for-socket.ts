import * as fs from "node:fs";
import { dirname } from "node:path";
import { isDaemonListening } from "./socket-probe";

export const waitForDaemonListening = (socketPath: string, signal: AbortSignal): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const state: { settled: boolean; watcher: fs.FSWatcher | null } = { settled: false, watcher: null };

    const settle = (listening: boolean): void => {
      if (state.settled) return;
      state.settled = true;
      state.watcher?.close();
      signal.removeEventListener("abort", onAbort);
      resolve(listening);
    };

    function onAbort(): void {
      settle(false);
    }

    const check = (): void => {
      if (state.settled) return;
      void isDaemonListening(socketPath).then((listening) => {
        if (listening) settle(true);
      });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    fs.mkdirSync(dirname(socketPath), { recursive: true });
    state.watcher = fs.watch(dirname(socketPath), () => check());
    state.watcher.on("error", () => settle(false));
    check();
  });
