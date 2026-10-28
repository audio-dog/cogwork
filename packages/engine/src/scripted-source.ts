import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Take from "effect/Take";
import type {
  SourceFailure,
  TriggerEvent,
  TriggerSource,
  TriggerSourceId,
  TriggerSubscription,
} from "./trigger-source";

export interface ScriptedSource {
  readonly source: TriggerSource;
  readonly emit: (event: TriggerEvent) => Effect.Effect<void>;
  readonly fail: (failure: SourceFailure) => Effect.Effect<void>;
  readonly subscriptions: Effect.Effect<ReadonlyArray<TriggerSubscription>>;
}

export const makeScriptedSource = (id: TriggerSourceId, entries: TriggerSource["entries"]) =>
  Effect.gen(function* () {
    const signals = yield* PubSub.unbounded<Take.Take<TriggerEvent, SourceFailure>>();
    const subscriptions = yield* Ref.make<ReadonlyArray<TriggerSubscription>>([]);
    const source: TriggerSource = {
      id,
      entries,
      availability: () => Effect.succeed({ _tag: "Available" }),
      listOptions: () => Effect.succeed([]),
      observe: (next) =>
        (next.length === 0 ? Stream.empty : Stream.fromPubSubTake(signals)).pipe(
          Stream.onStart(Ref.set(subscriptions, next)),
        ),
    };
    return {
      source,
      emit: (event) => PubSub.publish(signals, [event]).pipe(Effect.asVoid),
      fail: (failure) => PubSub.publish(signals, Exit.fail(failure)).pipe(Effect.asVoid),
      subscriptions: Ref.get(subscriptions),
    } satisfies ScriptedSource;
  });
