import type { WorkItem } from "contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RegisteredWorkspace } from "./projector";

const pendingEmpty = Effect.fn("WorkSource.pending")(function* (_workspace: RegisteredWorkspace) {
  return yield* Effect.succeed<ReadonlyArray<WorkItem>>([]);
});

export const makeEmpty = Effect.succeed({ pending: pendingEmpty } as const);

export class WorkSource extends Context.Service<WorkSource, Effect.Success<typeof makeEmpty>>()(
  "engine/workSource",
) {}

export const emptyLayer = Layer.effect(WorkSource, makeEmpty);
