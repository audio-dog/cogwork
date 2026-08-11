import { applyDaemonEvent, type Board, initialBoard } from "@clanker-forge/contracts";
import type * as Cause from "effect/Cause";
import { useLiveEvents } from "./use-live-events";

export type BoardResult =
  | { readonly _tag: "Initial" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
  | { readonly _tag: "Success"; readonly board: Board };

export function useBoard(): BoardResult {
  const result = useLiveEvents();

  if (result._tag === "Failure") return { _tag: "Failure", cause: result.cause };
  if (result._tag !== "Success") return { _tag: "Initial" };
  const board = result.value.items.reduce(applyDaemonEvent, initialBoard);
  return { _tag: "Success", board };
}
