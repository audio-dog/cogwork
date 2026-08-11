import { ClassifiedItem, itemKey, SchedulerStats } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { DaemonEventBus } from "./daemon-event-bus";
import { classifiedItemsOf, schedulerStatsOf } from "./read-model";
import { ReconcileWorker } from "./reconcile";
import { Scheduler } from "./scheduler";

const encodeItem = Schema.encodeSync(Schema.fromJsonString(ClassifiedItem));
const encodeStats = Schema.encodeSync(Schema.fromJsonString(SchedulerStats));

export const make = Effect.gen(function* () {
  const worker = yield* ReconcileWorker;
  const scheduler = yield* Scheduler;
  const bus = yield* DaemonEventBus;
  const lastItems = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const lastScheduler = yield* Ref.make<string | null>(null);

  const publishItems = Effect.fn("DaemonEventPublisher.publishItems")(function* () {
    const snapshot = yield* worker.snapshot;
    const signed = snapshot.workspaces.flatMap((state) =>
      classifiedItemsOf(state).map(
        (item) =>
          ({
            key: itemKey(state.name, item.id),
            signature: `${state.name}::${encodeItem(item)}`,
            workspace: state.name,
            item,
          }) as const,
      ),
    );
    const previous = yield* Ref.get(lastItems);
    const changed = signed.filter(({ key, signature }) => previous.get(key) !== signature);
    yield* Effect.forEach(
      changed,
      ({ workspace, item }) => bus.publish({ _tag: "ItemChanged", workspace, item }),
      { discard: true },
    );
    yield* Ref.set(lastItems, new Map(signed.map(({ key, signature }) => [key, signature] as const)));
  });

  const publishScheduler = Effect.fn("DaemonEventPublisher.publishScheduler")(function* () {
    const stats = schedulerStatsOf(scheduler.config, yield* scheduler.stats);
    const signature = encodeStats(stats);
    if ((yield* Ref.get(lastScheduler)) === signature) return;
    yield* Ref.set(lastScheduler, signature);
    yield* bus.publish({ _tag: "SchedulerChanged", scheduler: stats });
  });

  return { publishItems, publishScheduler } as const;
});

export type DaemonEventPublisherService = Effect.Success<typeof make>;

export class DaemonEventPublisher extends Context.Service<
  DaemonEventPublisher,
  DaemonEventPublisherService
>()("@clanker-forge/engine/event-publisher/DaemonEventPublisher") {}

export const layer = Layer.effect(DaemonEventPublisher, make);
