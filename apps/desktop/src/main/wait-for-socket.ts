import { Effect, Schedule } from "effect";
import { isDaemonListening } from "./socket-probe";

const probeSchedule = Schedule.spaced("50 millis");

export const waitForDaemonListening = (socketPath: string) =>
  isDaemonListening(socketPath).pipe(
    Effect.repeat({
      schedule: probeSchedule,
      until: (listening) => listening,
    }),
  );
