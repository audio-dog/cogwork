import type { AgUiEvent, DaemonEvent, RunActivity, RunRecord, RunSummary } from "@clanker-forge/contracts";
import { agUiCorrelation } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const activityOf = (
  record: Pick<RunRecord, "id" | "workspace" | "workItem" | "stage">,
  seq: number,
  atMillis: number,
  event: AgUiEvent,
): RunActivity => ({
  runId: record.id,
  workspace: record.workspace,
  workItem: record.workItem,
  stage: record.stage,
  seq,
  atMillis,
  correlation: agUiCorrelation(event),
  event,
});

type RunActivityEvent = Extract<DaemonEvent, { readonly _tag: "RunActivity" }>;

export const isRunActivity = (event: DaemonEvent): event is RunActivityEvent => event._tag === "RunActivity";

export const runActivityStream = <E, R>(events: Stream.Stream<DaemonEvent, E, R>) =>
  events.pipe(
    Stream.filter(isRunActivity),
    Stream.map((event) => event.activity),
  );

export const make = Effect.gen(function* () {
  // Sliding, not bounded: a stuck subscriber drops its oldest events instead of backpressuring publishers.
  const pubsub = yield* PubSub.sliding<DaemonEvent>(1024);
  const publish = (event: DaemonEvent) => PubSub.publish(pubsub, event);
  return {
    publish,
    publishActivity: (activity: RunActivity) => publish({ _tag: "RunActivity", activity }),
    publishRun: (run: RunSummary) => publish({ _tag: "RunChanged", run }),
    subscribe: () => PubSub.subscribe(pubsub),
    events: Stream.fromPubSub(pubsub),
    activity: runActivityStream(Stream.fromPubSub(pubsub)),
  } as const;
});

export type DaemonEventBusService = Effect.Success<typeof make>;

export class DaemonEventBus extends Context.Service<DaemonEventBus, DaemonEventBusService>()(
  "@clanker-forge/engine/daemon-event-bus/DaemonEventBus",
) {}

export const layer = Layer.effect(DaemonEventBus, make);
