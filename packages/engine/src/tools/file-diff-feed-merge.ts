import { AgUiEvent } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { tolerateFeedDeath } from "./file-diff-feed";

const feedDrainDeadline = "10 seconds";

class FileDiffDrainTimeout extends Data.TaggedError("FileDiffDrainTimeout")<{
  readonly deadline: string;
}> {}

// A client stops reading at `RUN_FINISHED`, so the feed must drain before it.
// `RUN_ERROR` is not held: the stream fails right behind it.
export const mergeBeforeRunFinished = Effect.fn("Tools.mergeBeforeRunFinished")(function* <E, FE, R>(
  harnessEvents: Stream.Stream<AgUiEvent, E>,
  feed: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, FE, R>,
) {
  const harnessDone = yield* Deferred.make<void>();
  const withheldTerminal = yield* Ref.make<AgUiEvent | null>(null);
  return Stream.merge(
    harnessEvents.pipe(
      Stream.filterEffect((event) =>
        AgUiEvent.guards.RUN_FINISHED(event)
          ? Effect.map(Ref.set(withheldTerminal, event), () => false)
          : Effect.succeed(true),
      ),
      Stream.ensuring(Deferred.succeed(harnessDone, undefined)),
    ),
    feed(Deferred.await(harnessDone)),
    { haltStrategy: "both" },
  ).pipe(
    Stream.concat(
      Stream.unwrap(
        Effect.map(Ref.get(withheldTerminal), (event) =>
          event === null ? Stream.empty : Stream.make(event),
        ),
      ),
    ),
  );
});

export const mergeFileDiffFeed = <E, R>(
  harnessEvents: Stream.Stream<AgUiEvent, E>,
  fileDiffs: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, unknown, R>,
  failureMessage: string,
) =>
  mergeBeforeRunFinished(harnessEvents, (stop) =>
    fileDiffs(stop).pipe(
      Stream.interruptWhen(
        Effect.andThen(stop, Effect.sleep(feedDrainDeadline)).pipe(
          Effect.andThen(Effect.fail(new FileDiffDrainTimeout({ deadline: feedDrainDeadline }))),
        ),
      ),
      tolerateFeedDeath(failureMessage),
    ),
  );
