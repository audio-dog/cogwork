import {
  type AgUiEvent,
  agUiCorrelation,
  DaemonEvent,
  type RunActivity,
  type RunRecord,
  type RunSummary,
} from "@cogwork/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

const capacity = 1024;
const droppedEventsMetric = Metric.counter("cogwork_daemon_event_bus_dropped_events_total", {
  description: "Daemon events evicted before every subscriber consumed them.",
});

const logDropStart = (count: number) => {
  if (count !== 1) return Effect.void;
  return Effect.logWarning("Daemon event bus started dropping events", {
    capacity,
    droppedEvents: count,
  });
};

const recordDrop = (droppedEvents: Ref.Ref<number>) =>
  Ref.updateAndGet(droppedEvents, (current) => current + 1).pipe(
    Effect.tap(() => Metric.update(droppedEventsMetric, 1)),
    Effect.tap(logDropStart),
    Effect.asVoid,
  );

class ObservedSlidingStrategy<A> extends PubSub.SlidingStrategy<A> {
  constructor(readonly onDrop: Effect.Effect<void>) {
    super();
  }

  override handleSurplus(
    pubsub: PubSub.PubSub.Atomic<A>,
    subscribers: PubSub.PubSub.Subscribers<A>,
    elements: Iterable<A>,
    isShutdown: Parameters<PubSub.SlidingStrategy<A>["handleSurplus"]>[3],
  ) {
    return super.handleSurplus(pubsub, subscribers, elements, isShutdown).pipe(Effect.tap(() => this.onDrop));
  }
}

export const activityOf = (
  record: Pick<RunRecord, "id" | "workspace" | "workItem" | "operation">,
  seq: number,
  atMillis: number,
  event: AgUiEvent,
): RunActivity => ({
  runId: record.id,
  workspace: record.workspace,
  workItem: record.workItem,
  operation: record.operation,
  seq,
  atMillis,
  correlation: agUiCorrelation(event),
  event,
});

type DaemonEventInput = DaemonEvent extends infer Event
  ? Event extends { readonly emittedAtMillis: number }
    ? Omit<Event, "emittedAtMillis">
    : never
  : never;

export const isRunActivity = DaemonEvent.guards.RunActivity;

export const runActivityStream = <E, R>(events: Stream.Stream<DaemonEvent, E, R>) =>
  events.pipe(
    Stream.filter(isRunActivity),
    Stream.map((event) => event.activity),
  );

export const make = Effect.gen(function* () {
  const droppedEvents = yield* Ref.make(0);
  const pubsub = yield* PubSub.make<DaemonEvent>({
    atomicPubSub: () => PubSub.makeAtomicBounded(capacity),
    strategy: () => new ObservedSlidingStrategy(recordDrop(droppedEvents)),
  });
  const publish = (event: DaemonEventInput) =>
    Effect.flatMap(Clock.currentTimeMillis, (emittedAtMillis) =>
      PubSub.publish(pubsub, { ...event, emittedAtMillis }),
    );
  return {
    publish,
    publishActivity: (activity: RunActivity) => publish({ _tag: "RunActivity", activity }),
    publishRun: (run: RunSummary) => publish({ _tag: "RunChanged", run }),
    droppedEvents: Ref.get(droppedEvents),
    subscribe: () => PubSub.subscribe(pubsub),
    events: Stream.fromPubSub(pubsub),
    activity: runActivityStream(Stream.fromPubSub(pubsub)),
  } as const;
});

export type DaemonEventBusService = Effect.Success<typeof make>;

export class DaemonEventBus extends Context.Service<DaemonEventBus, DaemonEventBusService>()(
  "@cogwork/engine/daemon-event-bus/DaemonEventBus",
) {}

export const layer = Layer.effect(DaemonEventBus, make);
