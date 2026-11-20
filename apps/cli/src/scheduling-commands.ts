import type { SchedulingState } from "@cogwork/contracts";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import { overSocket, socketFlag } from "./commands";
import { makeDaemonClient } from "./rpc";

export const schedulingActions = {
  pause: "paused",
  resume: "running",
} as const satisfies Record<"pause" | "resume", SchedulingState>;

const setScheduling = Effect.fn("commands.setScheduling")(
  function* (options: { readonly socketPath: string; readonly desired: SchedulingState }) {
    const client = yield* makeDaemonClient();
    const scheduler = yield* client.SetScheduling({ desired: options.desired });
    yield* Console.log(`scheduling: ${scheduler.scheduling}`);
  },
  (effect, options) => overSocket(effect, options.socketPath),
);

const schedulingPauseCommand = Command.make("pause", { socket: socketFlag }).pipe(
  Command.withDescription("Pause new runs; in-flight runs finish"),
  Command.withHandler(({ socket }) =>
    setScheduling({ socketPath: socket, desired: schedulingActions.pause }),
  ),
);

const schedulingResumeCommand = Command.make("resume", { socket: socketFlag }).pipe(
  Command.withDescription("Resume scheduling new runs"),
  Command.withHandler(({ socket }) =>
    setScheduling({ socketPath: socket, desired: schedulingActions.resume }),
  ),
);

export const schedulingCommand = Command.make("scheduling").pipe(
  Command.withDescription("Control new-run scheduling"),
  Command.withSubcommands([schedulingPauseCommand, schedulingResumeCommand]),
);
