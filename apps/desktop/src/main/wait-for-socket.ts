import { Effect, Schedule, Schema } from "effect";

import { isDaemonListening } from "./socket-probe";

const probeSchedule = Schedule.spaced("50 millis");
const daemonReachabilityDeadline = "10 seconds";

export class DaemonReachabilityError extends Schema.TaggedError<DaemonReachabilityError>()(
  "DaemonReachabilityError",
  { deadline: Schema.String },
) {
  override get message() {
    return `Daemon did not become reachable within ${this.deadline}`;
  }
}

export const waitForDaemonListening = (socketPath: string) =>
  isDaemonListening(socketPath).pipe(
    Effect.repeat({
      schedule: probeSchedule,
      until: (listening) => listening,
    }),
    Effect.timeout(daemonReachabilityDeadline),
    Effect.catchTag(
      "TimeoutError",
      () => new DaemonReachabilityError({ deadline: daemonReachabilityDeadline }),
    ),
  );
