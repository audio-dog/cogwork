import { applyDaemonEvent, type Board, initialBoard } from "@clanker-forge/contracts";
import type * as Cause from "effect/Cause";
import { type RunActivityPreview, runPreviews } from "./run-activity";
import { useLiveEvents } from "./use-live-events";

export type BoardResult =
  | { readonly _tag: "Initial" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
  | {
      readonly _tag: "Success";
      readonly board: Board;
      readonly previews: ReadonlyMap<string, RunActivityPreview>;
    };

export function useBoard(): BoardResult {
  const result = useLiveEvents();

  if (result._tag === "Failure") return { _tag: "Failure", cause: result.cause };
  if (result._tag !== "Success") return { _tag: "Initial" };
  const events = result.value.items;
  const board = events.reduce(applyDaemonEvent, initialBoard);
  return { _tag: "Success", board, previews: runPreviews(events) };
}
