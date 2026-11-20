import {
  type DesktopProcessHealthSample,
  DesktopProcessHealthSample as DesktopProcessHealthSampleSchema,
  type RendererProcessHealthSample,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";

import { ratePerSecond } from "../../../shared/process-health";

interface RendererCounters {
  readonly protocolInboxDepth: number;
  readonly eventsApplied: number;
}

interface RendererBaseline {
  readonly sampledAtMillis: number;
  readonly eventsApplied: number;
}

const counters = MutableRef.make<RendererCounters>({ protocolInboxDepth: 0, eventsApplied: 0 });

const updateCounters = (update: (current: RendererCounters) => RendererCounters) =>
  MutableRef.update(counters, update);

export const recordProtocolInboxChange = (change: number) =>
  updateCounters((current) => ({
    ...current,
    protocolInboxDepth: Math.max(0, current.protocolInboxDepth + change),
  }));

export const resetProtocolInboxDepth = () =>
  updateCounters((current) => ({ ...current, protocolInboxDepth: 0 }));

export const recordDaemonEventsApplied = (count: number) =>
  updateCounters((current) => ({
    ...current,
    eventsApplied: current.eventsApplied + count,
  }));

const measureRendererSample = (
  sample: RendererProcessHealthSample,
  current: RendererCounters,
  previous: RendererBaseline,
) => ({
  ...sample,
  protocolInboxDepth: current.protocolInboxDepth,
  eventsAppliedPerSecond: ratePerSecond(
    previous.eventsApplied,
    current.eventsApplied,
    sample.sampledAtMillis - previous.sampledAtMillis,
  ),
});

const rendererBaseline = (sample: RendererProcessHealthSample, eventsApplied: number): RendererBaseline => ({
  sampledAtMillis: sample.sampledAtMillis,
  eventsApplied,
});

export const reportDesktopProcessHealth = <E, R>(
  read: () => Promise<ReadonlyArray<DesktopProcessHealthSample>>,
  report: (samples: ReadonlyArray<DesktopProcessHealthSample>) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const previous = yield* Ref.make<RendererBaseline>({
      sampledAtMillis: Date.now(),
      eventsApplied: MutableRef.get(counters).eventsApplied,
    });
    yield* Effect.tryPromise(read).pipe(
      Effect.flatMap((samples) =>
        Effect.all([Effect.succeed(samples), Effect.sync(() => MutableRef.get(counters)), Ref.get(previous)]),
      ),
      Effect.flatMap(([samples, current, baseline]) => {
        const measured = samples.map((sample) =>
          DesktopProcessHealthSampleSchema.match(sample, {
            main: (main) => main,
            renderer: (renderer) => measureRendererSample(renderer, current, baseline),
          }),
        );
        const renderer = samples.flatMap((sample) =>
          DesktopProcessHealthSampleSchema.match(sample, {
            main: () => [],
            renderer: (currentRenderer) => [currentRenderer],
          }),
        )[0];
        const updateBaseline = renderer
          ? Ref.set(previous, rendererBaseline(renderer, current.eventsApplied))
          : Effect.void;
        return updateBaseline.pipe(Effect.andThen(report(measured)));
      }),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("desktop process health report failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.provideService(References.TracerEnabled, false),
    );
  });
