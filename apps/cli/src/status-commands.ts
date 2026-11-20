import type { ControlStore, DaemonStatus } from "@cogwork/contracts";
import { readControlStore } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import { controlStoreFlag, daemonOrStore, socketFlag } from "./commands";
import { clientLayer, makeDaemonClient } from "./rpc";
import { formatOfflineStatus, formatStatus, formatStatusWithStore } from "./status";

export const daemonStatusPicture = Effect.fn("commands.daemonStatusPicture")(function* <E, R>(
  status: DaemonStatus,
  controlStore: Effect.Effect<ControlStore, E, R>,
) {
  if (status.health === "store-unavailable") return formatStatus(status);
  return formatStatusWithStore(status, yield* controlStore);
});

const runStatus = Effect.fn("commands.runStatus")(function* (options: {
  readonly socketPath: string;
  readonly controlStorePath: string;
}) {
  yield* daemonOrStore(
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      const status = yield* client.GetStatus();
      return yield* daemonStatusPicture(status, client.GetControlStore());
    }).pipe(Effect.scoped, Effect.provide(clientLayer(options.socketPath))),
    readControlStore(options.controlStorePath).pipe(Effect.map(formatOfflineStatus)),
  ).pipe(Effect.flatMap(Console.log));
});

export const statusCommand = Command.make("status", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    runStatus({ socketPath: socket, controlStorePath: controlStore }),
  ),
);
