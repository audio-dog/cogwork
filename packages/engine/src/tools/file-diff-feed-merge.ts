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

export const mergeFileDiffFeed = Effect.fn("Tools.mergeFileDiffFeed")(function* <E, R>(
  harnessEvents: Stream.Stream<AgUiEvent, E>,
  fileDiffs: (stop: Effect.Effect<void>) => Stream.Stream<AgUiEvent, unknown, R>,
  failureMessage: string,
) {
  const harnessDone = yield* Deferred.make<void>();
  const withheldTerminal = yield* Ref.make<AgUiEvent | null>(null);
  const stop = Deferred.await(harnessDone);
  return Stream.merge(
    harnessEvents.pipe(
      Stream.filterEffect((event) =>
        AgUiEvent.guards.RUN_FINISHED(event)
          ? Effect.map(Ref.set(withheldTerminal, event), () => false)
          : Effect.succeed(true),
      ),
      Stream.ensuring(Deferred.succeed(harnessDone, undefined)),
    ),
    fileDiffs(stop).pipe(
      Stream.interruptWhen(
        Effect.andThen(stop, Effect.sleep(feedDrainDeadline)).pipe(
          Effect.andThen(Effect.fail(new FileDiffDrainTimeout({ deadline: feedDrainDeadline }))),
        ),
      ),
      tolerateFeedDeath(failureMessage),
    ),
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
