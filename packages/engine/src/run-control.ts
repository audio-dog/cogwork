import type { RunId } from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const withoutKey = (map: ReadonlyMap<RunId, Fiber.Fiber<unknown, unknown>>, runId: RunId) => {
  if (!map.has(runId)) return map;
  const next = new Map(map);
  next.delete(runId);
  return next;
};

export const make = Effect.gen(function* () {
  const fibers = yield* Ref.make<ReadonlyMap<RunId, Fiber.Fiber<unknown, unknown>>>(new Map());

  const register = (runId: RunId, fiber: Fiber.Fiber<unknown, unknown>) =>
    Ref.update(fibers, (map) => new Map(map).set(runId, fiber));

  const unregister = (runId: RunId) => Ref.update(fibers, (map) => withoutKey(map, runId));

  const cancel = Effect.fn("RunControl.cancel")(function* (runId: RunId) {
    const fiber = (yield* Ref.get(fibers)).get(runId);
    if (fiber === undefined) return false;
    yield* unregister(runId);
    yield* Fiber.interrupt(fiber);
    return true;
  });

  return { register, unregister, cancel } as const;
});

export type RunControlService = Effect.Success<typeof make>;

export class RunControl extends Context.Service<RunControl, RunControlService>()(
  "@cogwork/engine/run-control/RunControl",
) {}

export const layer = Layer.effect(RunControl, make);
