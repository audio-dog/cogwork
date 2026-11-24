import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import {
  type ControlStoreReadOptions,
  controlStoreFlag,
  currentControlStore,
  overSocket,
  socketFlag,
} from "./commands";
import { makeDaemonClient } from "./rpc";
import { formatDaemonLimits } from "./status";

const daemonLimitKeyArgument = Argument.Literals("limit", [
  "global-concurrency",
  "per-workspace-concurrency",
  "daily-budget",
]);

const daemonLimitValueArgument = Argument.Int("value");

const showLimits = Effect.fn("commands.showLimits")(function* (options: ControlStoreReadOptions) {
  yield* currentControlStore(options).pipe(Effect.map(formatDaemonLimits), Effect.flatMap(Console.log));
});

const setLimit = Effect.fn("commands.setLimit")(
  function* (options: {
    readonly socketPath: string;
    readonly limit: "global-concurrency" | "per-workspace-concurrency" | "daily-budget";
    readonly value: number;
  }) {
    const client = yield* makeDaemonClient();
    const current = yield* client.GetControlStore();
    const controlStore = yield* client.SetDaemonLimit({
      update: {
        key: options.limit,
        value: options.value,
        expectedRevision: current.daemonLimits.revision,
      },
    });
    yield* Console.log(formatDaemonLimits(controlStore));
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const limitsShowCommand = Command.make("show", {
  socket: socketFlag,
  controlStore: controlStoreFlag,
}).pipe(
  Command.withHandler(({ socket, controlStore }) =>
    showLimits({ socketPath: socket, controlStorePath: controlStore }),
  ),
);

const limitsSetCommand = Command.make("set", {
  socket: socketFlag,
  limit: daemonLimitKeyArgument,
  value: daemonLimitValueArgument,
}).pipe(Command.withHandler(({ socket, limit, value }) => setLimit({ socketPath: socket, limit, value })));

export const limitsCommand = Command.make("limits").pipe(
  Command.withSubcommands([limitsShowCommand, limitsSetCommand]),
);
