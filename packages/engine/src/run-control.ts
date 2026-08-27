import type { RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";

export const make = Effect.gen(function* () {
  const fibers = yield* FiberMap.make<RunId>();

  const register = (runId: RunId, fiber: Fiber.Fiber<unknown, unknown>) => FiberMap.set(fibers, runId, fiber);

  const cancel = Effect.fn("RunControl.cancel")(function* (runId: RunId) {
    const found = yield* FiberMap.has(fibers, runId);
    yield* FiberMap.remove(fibers, runId);
    return found;
  });

  return { register, cancel } as const;
});

export type RunControlService = Effect.Success<typeof make>;

export class RunControl extends Context.Service<RunControl, RunControlService>()(
  "@cogwork/engine/run-control/RunControl",
) {}

export const layer = Layer.effect(RunControl, make);
