import type { RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import type { WorkspaceIssueTrackerBinding } from "./projector";

export const make = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<RunId>();
  const workspaces = MutableHashMap.empty<
    RunId,
    { readonly fiber: Fiber.Fiber<unknown, unknown>; readonly workspace: WorkspaceIssueTrackerBinding }
  >();

  const register = (
    runId: RunId,
    fiber: Fiber.Fiber<unknown, unknown>,
    workspace?: WorkspaceIssueTrackerBinding,
  ) =>
    Effect.sync(() => {
      if (!workspace) return;
      MutableHashMap.set(workspaces, runId, { fiber, workspace });
      fiber.addObserver(() => {
        const current = MutableHashMap.get(workspaces, runId);
        if (Option.isSome(current) && current.value.fiber === fiber) MutableHashMap.remove(workspaces, runId);
      });
    }).pipe(Effect.andThen(FiberMap.set(fibers, runId, fiber)));

  const workspaceFor = (runId: RunId) =>
    Effect.sync(() => Option.map(MutableHashMap.get(workspaces, runId), ({ workspace }) => workspace));

  const cancel = Effect.fn("RunControl.cancel")(function* (runId: RunId) {
    const found = yield* FiberMap.has(fibers, runId);
    yield* FiberMap.remove(fibers, runId);
    return found;
  });

  return { register, workspaceFor, cancel } as const;
});

export type RunControlService = Effect.Success<typeof make>;

export class RunControl extends Context.Service<RunControl, RunControlService>()(
  "@cogwork/engine/run-control/RunControl",
) {}

export const layer = Layer.effect(RunControl, make);
