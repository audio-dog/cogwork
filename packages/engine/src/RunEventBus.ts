import type { HarnessEvent, RunActivity, RunRecord } from "@clanker-forge/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const activityOf = (
  record: Pick<RunRecord, "id" | "workspace" | "workItem" | "stage">,
  seq: number,
  atMillis: number,
  event: HarnessEvent,
) => ({
  runId: record.id,
  workspace: record.workspace,
  workItem: record.workItem,
  stage: record.stage,
  seq,
  atMillis,
  event,
});

export const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.sliding<RunActivity>(1024);
  return {
    publish: (activity: RunActivity) => PubSub.publish(pubsub, activity),
    subscribe: () => PubSub.subscribe(pubsub),
    activity: Stream.fromPubSub(pubsub),
  } as const;
});

export type RunEventBusService = Effect.Success<typeof make>;

export class RunEventBus extends Context.Service<RunEventBus, RunEventBusService>()(
  "@clanker-forge/engine/RunEventBus",
) {}

export const layer = Layer.effect(RunEventBus, make);
