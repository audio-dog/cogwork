import * as net from "node:net";

import { Effect } from "effect";

export const isDaemonListening = (socketPath: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = net.connect({ path: socketPath });

    const settle = (listening: boolean) => {
      socket.destroy();
      resume(Effect.succeed(listening));
    };

    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeout(500),
    Effect.orElseSucceed(() => false),
  );
