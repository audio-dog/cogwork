import type { RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { WorkspaceIssueTrackerBinding } from "./projector";

const WorkspaceBinding = Context.Reference<Option.Option<WorkspaceIssueTrackerBinding>>(
  "@cogwork/engine/run-control/WorkspaceBinding",
  { defaultValue: Option.none },
);

export const make = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<RunId>();

  const register = (
    runId: RunId,
    fiber: Fiber.Fiber<unknown, unknown>,
    workspace?: WorkspaceIssueTrackerBinding,
  ) =>
    Effect.sync(() => {
      if (!workspace) return;
      fiber.setContext(Context.add(fiber.context, WorkspaceBinding, Option.some(workspace)));
    }).pipe(Effect.andThen(FiberMap.set(fibers, runId, fiber)));

  const workspaceFor = (runId: RunId) =>
    FiberMap.get(fibers, runId).pipe(Effect.map(Option.flatMap((fiber) => fiber.getRef(WorkspaceBinding))));

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
