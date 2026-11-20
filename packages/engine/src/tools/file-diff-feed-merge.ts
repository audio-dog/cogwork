import type { AgUiEvent } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { tolerateFeedDeath } from "./file-diff-feed";
import { mergeBeforeRunFinished } from "./merge-before-run-finished";

const feedDrainDeadline = "10 seconds";

class FileDiffDrainTimeout extends Data.TaggedError("FileDiffDrainTimeout")<{
  readonly deadline: string;
}> {}

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
